// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEVMFS} from "./interfaces/IEVMFS.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/// @title EVMFSCollectionRegistry
/// @notice Discovery catalog for on-chain (and merely supported) NFT collections.
///
/// Tiered support model:
///   - EVMFS_V1 / EVMFS_V2  → first class (launchpad, viewer iframe, hash verify)
///   - ON_CHAIN_DATA_URI    → business class (data: URIs in tokenURI)
///   - OFFCHAIN             → pleb class (IPFS/HTTP; still browsable, ranked lower)
///
/// Anti-grief is kind-aware:
///   - EVMFS_*  → `IEVMFS.manifests(metadataManifest) == msg.sender`
///   - others   → `IOwnable(nftContract).owner() == msg.sender`
///   - registerCurated → registry `owner` only (bypass; for bootstrap + non-Ownable)
///
/// Curation surface (registry `owner` controlled): `verified` mark per nft and
/// `tags` per collection. Tags are also settable by the original `creator`.
contract EVMFSCollectionRegistry {
    // ═══════════════════════════ CONSTANTS ═══════════════════════════

    /// @notice EVMFS V1 — legacy storage contract.
    address public constant EVMFS_V1 = 0x140cbDFf649929D003091a5B8B3be34588753aBA;

    /// @notice EVMFS V2 — current/default storage contract.
    address public constant EVMFS_V2 = 0xb61cdCDC81d97c32122E668AE782b2327d0a623C;

    /// @notice Cap on tags per collection.
    uint256 public constant MAX_TAGS = 8;

    /// @notice Cap on a single tag's byte length.
    uint256 public constant MAX_TAG_LENGTH = 24;

    // ═══════════════════════════ TYPES ═══════════════════════════

    enum Kind {
        EVMFS_V1,
        EVMFS_V2,
        ON_CHAIN_DATA_URI,
        OFFCHAIN
    }

    struct Collection {
        Kind kind;
        address evmfsContract; // zero when !isEvmfsKind(kind)
        bytes32 metadataManifest; // zero when !isEvmfsKind(kind)
        uint64 metadataBlock;
        bytes32 indexManifest;
        uint64 indexBlock;
        uint64 totalSupply;
        address nftContract;
        address creator;
        string name;
        string symbol;
    }

    /// @notice Bundled struct argument to keep `register` / `registerCurated`
    ///         within Solidity stack limits and minimize ABI churn on future
    ///         field additions.
    struct RegistrationInput {
        Kind kind;
        bytes32 metadataManifest;
        uint64 metadataBlock;
        bytes32 indexManifest;
        uint64 indexBlock;
        uint64 totalSupply;
        address nftContract;
        string name;
        string symbol;
    }

    // ═══════════════════════════ STORAGE ═══════════════════════════

    mapping(uint256 => Collection) public collections;
    uint256 public count;

    mapping(address => uint256) public collectionIdByNft;
    mapping(address => uint256[]) private _collectionsByCreator;

    /// @notice Registry deployer. May set `verified`, perform curated bootstrap
    ///         registrations, and transfer/renounce ownership.
    address public owner;

    /// @notice Verified mark, keyed by nftContract. Frontend renders a checkmark.
    mapping(address => bool) public verified;

    /// @notice Free-form tags per collection id. Bounded by {@link MAX_TAGS}.
    mapping(uint256 => string[]) private _tags;

    // ═══════════════════════════ EVENTS ═══════════════════════════

    event Registered(
        uint256 indexed id,
        address indexed creator,
        address indexed nftContract,
        Kind kind
    );
    event MetadataUpdated(uint256 indexed id, bytes32 metadataManifest, uint64 metadataBlock);
    event IndexUpdated(uint256 indexed id, bytes32 indexManifest, uint64 indexBlock);
    event TotalSupplyUpdated(uint256 indexed id, uint64 totalSupply);
    event Verified(address indexed nftContract, bool isVerified);
    event TagsUpdated(uint256 indexed id, string[] tags);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ═══════════════════════════ ERRORS ═══════════════════════════

    error UnsupportedEvmfsContract();
    error NotUploader();
    error NotContractOwner();
    error AlreadyRegistered();
    error InvalidNftContract();
    error InvalidManifest();
    error InvalidName();
    error CollectionNotFound();
    error NotCreator();
    error NotOwner();
    error BlockResolutionFailed();
    error InvalidKind();
    error TooManyTags();
    error TagTooLong();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ═══════════════════════════ MODIFIERS ═══════════════════════════

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ═══════════════════════════ REGISTRATION ═══════════════════════════

    /// @notice Permissionless registration. Auth depends on `input.kind`:
    ///         EVMFS kinds require the manifest uploader, others require the
    ///         NFT contract's `Ownable.owner()` to equal `msg.sender`.
    function register(RegistrationInput calldata input) external returns (uint256 id) {
        return _register(input, msg.sender, false);
    }

    /// @notice Owner-only bootstrap path. Bypasses kind-specific auth and lets
    ///         the registry deployer onboard non-Ownable or legacy collections
    ///         (e.g. Skrumpeys) while crediting the real creator. Auto-marks
    ///         the entry as verified.
    function registerCurated(RegistrationInput calldata input, address creator_)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (creator_ == address(0)) revert InvalidNftContract();
        id = _register(input, creator_, true);
        verified[input.nftContract] = true;
        emit Verified(input.nftContract, true);
    }

    function _register(RegistrationInput calldata input, address creator_, bool curated)
        internal
        returns (uint256 id)
    {
        if (input.nftContract == address(0)) revert InvalidNftContract();
        if (collectionIdByNft[input.nftContract] != 0) revert AlreadyRegistered();
        if (bytes(input.name).length == 0) revert InvalidName();

        address evmfsContract = _evmfsAddressFor(input.kind);
        uint64 metadataBlock = input.metadataBlock;
        uint64 indexBlock = input.indexBlock;

        if (isEvmfsKind(input.kind)) {
            if (input.metadataManifest == bytes32(0)) revert InvalidManifest();
            if (!curated) {
                if (IEVMFS(evmfsContract).manifests(input.metadataManifest) != msg.sender) {
                    revert NotUploader();
                }
            }
            if (metadataBlock == 0) {
                metadataBlock = _resolveBlock(evmfsContract, input.metadataManifest);
            }
            if (input.indexManifest != bytes32(0) && indexBlock == 0) {
                indexBlock = _resolveBlock(evmfsContract, input.indexManifest);
            }
        } else {
            // Non-EVMFS kinds — manifest fields must be zero.
            if (
                input.metadataManifest != bytes32(0) ||
                input.indexManifest != bytes32(0) ||
                input.metadataBlock != 0 ||
                input.indexBlock != 0
            ) {
                revert InvalidManifest();
            }
            if (!curated) {
                _requireContractOwner(input.nftContract);
            }
        }

        unchecked {
            id = ++count;
        }

        collections[id] = Collection({
            kind: input.kind,
            evmfsContract: evmfsContract,
            metadataManifest: input.metadataManifest,
            metadataBlock: metadataBlock,
            indexManifest: input.indexManifest,
            indexBlock: indexBlock,
            totalSupply: input.totalSupply,
            nftContract: input.nftContract,
            creator: creator_,
            name: input.name,
            symbol: input.symbol
        });

        collectionIdByNft[input.nftContract] = id;
        _collectionsByCreator[creator_].push(id);

        emit Registered(id, creator_, input.nftContract, input.kind);
    }

    // ═══════════════════════════ MUTABLE UPDATES ═══════════════════════════

    /// @notice Re-point the metadata manifest. EVMFS kinds re-validate the
    ///         uploader; non-EVMFS kinds re-validate `Ownable.owner()`.
    function updateMetadata(uint256 id, bytes32 metadataManifest, uint64 metadataBlock) external {
        Collection storage c = _getOwned(id);
        if (isEvmfsKind(c.kind)) {
            if (metadataManifest == bytes32(0)) revert InvalidManifest();
            if (IEVMFS(c.evmfsContract).manifests(metadataManifest) != msg.sender) revert NotUploader();
            if (metadataBlock == 0) {
                metadataBlock = _resolveBlock(c.evmfsContract, metadataManifest);
            }
            c.metadataManifest = metadataManifest;
            c.metadataBlock = metadataBlock;
        } else {
            if (metadataManifest != bytes32(0) || metadataBlock != 0) revert InvalidManifest();
            // No-op on non-EVMFS kinds: tokenURI lives on the ERC721 contract.
        }
        emit MetadataUpdated(id, c.metadataManifest, c.metadataBlock);
    }

    function updateIndex(uint256 id, bytes32 indexManifest, uint64 indexBlock) external {
        Collection storage c = _getOwned(id);
        if (isEvmfsKind(c.kind)) {
            if (indexManifest != bytes32(0)) {
                if (IEVMFS(c.evmfsContract).manifests(indexManifest) != msg.sender) revert NotUploader();
                if (indexBlock == 0) {
                    indexBlock = _resolveBlock(c.evmfsContract, indexManifest);
                }
            } else {
                indexBlock = 0;
            }
            c.indexManifest = indexManifest;
            c.indexBlock = indexBlock;
        } else {
            if (indexManifest != bytes32(0) || indexBlock != 0) revert InvalidManifest();
        }
        emit IndexUpdated(id, c.indexManifest, c.indexBlock);
    }

    function updateTotalSupply(uint256 id, uint64 totalSupply) external {
        Collection storage c = _getOwned(id);
        c.totalSupply = totalSupply;
        emit TotalSupplyUpdated(id, totalSupply);
    }

    // ═══════════════════════════ CURATION ═══════════════════════════

    function setVerified(address nftContract, bool isVerified) external onlyOwner {
        verified[nftContract] = isVerified;
        emit Verified(nftContract, isVerified);
    }

    /// @notice Set tags on a collection. Callable by the collection's creator
    ///         or the registry owner. Replaces the existing tag set.
    function setTags(uint256 id, string[] calldata tags) external {
        Collection storage c = collections[id];
        if (c.nftContract == address(0)) revert CollectionNotFound();
        if (msg.sender != c.creator && msg.sender != owner) revert NotCreator();
        if (tags.length > MAX_TAGS) revert TooManyTags();

        for (uint256 i; i < tags.length; ++i) {
            uint256 len = bytes(tags[i]).length;
            if (len == 0 || len > MAX_TAG_LENGTH) revert TagTooLong();
        }

        delete _tags[id];
        for (uint256 i; i < tags.length; ++i) {
            _tags[id].push(tags[i]);
        }
        emit TagsUpdated(id, tags);
    }

    function getTags(uint256 id) external view returns (string[] memory) {
        return _tags[id];
    }

    // ═══════════════════════════ OWNERSHIP ═══════════════════════════

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    // ═══════════════════════════ VIEW HELPERS ═══════════════════════════

    function getCollection(uint256 id) external view returns (Collection memory) {
        Collection memory c = collections[id];
        if (c.nftContract == address(0)) revert CollectionNotFound();
        return c;
    }

    function getCollections(uint256 offset, uint256 limit) external view returns (Collection[] memory result) {
        uint256 total = count;
        if (offset >= total) return new Collection[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 size = end - offset;
        result = new Collection[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = collections[offset + i + 1];
        }
    }

    function getCollectionByNft(address nftContract) external view returns (Collection memory) {
        uint256 id = collectionIdByNft[nftContract];
        if (id == 0) revert CollectionNotFound();
        return collections[id];
    }

    function isRegistered(address nftContract) external view returns (bool) {
        return collectionIdByNft[nftContract] != 0;
    }

    function collectionsByCreator(address creator) external view returns (uint256[] memory) {
        return _collectionsByCreator[creator];
    }

    function collectionsByCreatorCount(address creator) external view returns (uint256) {
        return _collectionsByCreator[creator].length;
    }

    /// @notice True for EVMFS_V1 and EVMFS_V2.
    function isEvmfsKind(Kind kind) public pure returns (bool) {
        return kind == Kind.EVMFS_V1 || kind == Kind.EVMFS_V2;
    }

    // ═══════════════════════════ INTERNAL ═══════════════════════════

    function _getOwned(uint256 id) internal view returns (Collection storage c) {
        c = collections[id];
        if (c.nftContract == address(0)) revert CollectionNotFound();
        if (c.creator != msg.sender) revert NotCreator();
    }

    function _evmfsAddressFor(Kind kind) internal pure returns (address) {
        if (kind == Kind.EVMFS_V1) return EVMFS_V1;
        if (kind == Kind.EVMFS_V2) return EVMFS_V2;
        if (kind == Kind.ON_CHAIN_DATA_URI || kind == Kind.OFFCHAIN) return address(0);
        revert InvalidKind();
    }

    function _requireContractOwner(address nftContract) internal view {
        if (nftContract.code.length == 0) revert NotContractOwner();
        try IOwnable(nftContract).owner() returns (address contractOwner) {
            if (contractOwner != msg.sender) revert NotContractOwner();
        } catch {
            revert NotContractOwner();
        }
    }

    function _resolveBlock(address evmfsContract, bytes32 hash) internal view returns (uint64) {
        if (evmfsContract != EVMFS_V2) revert BlockResolutionFailed();
        try IEVMFS(evmfsContract).blockOf(hash) returns (uint256 b) {
            if (b == 0 || b > type(uint64).max) revert BlockResolutionFailed();
            return uint64(b);
        } catch {
            revert BlockResolutionFailed();
        }
    }
}
