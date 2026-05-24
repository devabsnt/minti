// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EVMFSCollectionRegistry} from "../src/EVMFSCollectionRegistry.sol";
import {MockEVMFS} from "./mocks/MockEVMFS.sol";
import {MockOwnable721} from "./mocks/MockOwnable721.sol";

contract EVMFSCollectionRegistryTest is Test {
    EVMFSCollectionRegistry registry;
    MockEVMFS mockV1;
    MockEVMFS mockV2;

    address constant EVMFS_V1 = 0x140cbDFf649929D003091a5B8B3be34588753aBA;
    address constant EVMFS_V2 = 0xb61cdCDC81d97c32122E668AE782b2327d0a623C;

    address deployer = address(this);
    address creator = makeAddr("creator");
    address rando = makeAddr("rando");
    address nft = makeAddr("nft");
    address nft2 = makeAddr("nft2");

    bytes32 constant METADATA_HASH = bytes32(uint256(0xa1));
    bytes32 constant INDEX_HASH = bytes32(uint256(0xc3));

    function setUp() public {
        MockEVMFS proto = new MockEVMFS();
        bytes memory code = address(proto).code;
        vm.etch(EVMFS_V1, code);
        vm.etch(EVMFS_V2, code);

        mockV1 = MockEVMFS(EVMFS_V1);
        mockV2 = MockEVMFS(EVMFS_V2);

        registry = new EVMFSCollectionRegistry();

        mockV2.setManifestUploader(METADATA_HASH, creator);
        mockV2.setManifestBlock(METADATA_HASH, 71_118_217);
        mockV2.setManifestUploader(INDEX_HASH, creator);
        mockV2.setManifestBlock(INDEX_HASH, 71_118_300);

        mockV1.setManifestUploader(METADATA_HASH, creator);
        mockV1.setManifestUploader(INDEX_HASH, creator);
    }

    // ─── helpers ─────────────────────────────────────────────────

    function _evmfsInput(EVMFSCollectionRegistry.Kind kind, bytes32 meta, uint64 metaBlk, bytes32 idx, uint64 idxBlk, address nftAddr)
        internal
        pure
        returns (EVMFSCollectionRegistry.RegistrationInput memory)
    {
        return EVMFSCollectionRegistry.RegistrationInput({
            kind: kind,
            metadataManifest: meta,
            metadataBlock: metaBlk,
            indexManifest: idx,
            indexBlock: idxBlk,
            totalSupply: 3333,
            nftContract: nftAddr,
            name: "Skrumpeys",
            symbol: "SKRUMP"
        });
    }

    function _registerV2(address asWho, address nftAddr) internal returns (uint256) {
        vm.prank(asWho);
        return registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V2, METADATA_HASH, 0, INDEX_HASH, 0, nftAddr));
    }

    // ═══════════════════════════ HAPPY PATHS ═══════════════════════════

    function test_constants() public view {
        assertEq(registry.EVMFS_V1(), EVMFS_V1);
        assertEq(registry.EVMFS_V2(), EVMFS_V2);
        assertEq(registry.MAX_TAGS(), 8);
        assertEq(registry.MAX_TAG_LENGTH(), 24);
    }

    function test_constructor_setsDeployerAsOwner() public view {
        assertEq(registry.owner(), deployer);
    }

    function test_register_v2_autoResolvesBlocks() public {
        vm.expectEmit(true, true, true, true);
        emit EVMFSCollectionRegistry.Registered(1, creator, nft, EVMFSCollectionRegistry.Kind.EVMFS_V2);
        uint256 id = _registerV2(creator, nft);
        assertEq(id, 1);

        EVMFSCollectionRegistry.Collection memory c = registry.getCollection(1);
        assertEq(uint256(c.kind), uint256(EVMFSCollectionRegistry.Kind.EVMFS_V2));
        assertEq(c.evmfsContract, EVMFS_V2);
        assertEq(c.metadataManifest, METADATA_HASH);
        assertEq(c.metadataBlock, 71_118_217);
        assertEq(c.indexManifest, INDEX_HASH);
        assertEq(c.indexBlock, 71_118_300);
        assertEq(c.totalSupply, 3333);
        assertEq(c.nftContract, nft);
        assertEq(c.creator, creator);
        assertEq(c.name, "Skrumpeys");
        assertEq(c.symbol, "SKRUMP");
    }

    function test_register_v1_acceptsExplicitBlocks() public {
        vm.prank(creator);
        uint256 id = registry.register(
            _evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V1, METADATA_HASH, 71_118_217, bytes32(0), 0, nft)
        );
        EVMFSCollectionRegistry.Collection memory c = registry.getCollection(id);
        assertEq(c.evmfsContract, EVMFS_V1);
        assertEq(c.metadataBlock, 71_118_217);
    }

    function test_register_v1_revertsWithoutExplicitBlock() public {
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.BlockResolutionFailed.selector);
        registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V1, METADATA_HASH, 0, bytes32(0), 0, nft));
    }

    function test_register_onChainDataUri_requiresOwnable() public {
        address onchainOwner = makeAddr("onchainOwner");
        MockOwnable721 ownable = new MockOwnable721(onchainOwner);

        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.ON_CHAIN_DATA_URI,
            metadataManifest: bytes32(0),
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 100,
            nftContract: address(ownable),
            name: "OnChain",
            symbol: "OC"
        });

        vm.prank(onchainOwner);
        uint256 id = registry.register(input);

        EVMFSCollectionRegistry.Collection memory c = registry.getCollection(id);
        assertEq(uint256(c.kind), uint256(EVMFSCollectionRegistry.Kind.ON_CHAIN_DATA_URI));
        assertEq(c.evmfsContract, address(0));
        assertEq(c.metadataManifest, bytes32(0));
        assertEq(c.creator, onchainOwner);
    }

    function test_register_offchain_requiresOwnable() public {
        address ownerOfOffchain = makeAddr("ownerOfOffchain");
        MockOwnable721 ownable = new MockOwnable721(ownerOfOffchain);

        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.OFFCHAIN,
            metadataManifest: bytes32(0),
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 10,
            nftContract: address(ownable),
            name: "Pleb",
            symbol: "PLB"
        });

        vm.prank(ownerOfOffchain);
        uint256 id = registry.register(input);
        assertEq(uint256(registry.getCollection(id).kind), uint256(EVMFSCollectionRegistry.Kind.OFFCHAIN));
    }

    function test_register_indexesCollectionByNft() public {
        _registerV2(creator, nft);
        assertEq(registry.collectionIdByNft(nft), 1);
        assertTrue(registry.isRegistered(nft));
    }

    function test_register_tracksCreatorCollections() public {
        _registerV2(creator, nft);
        bytes32 meta2 = bytes32(uint256(0xd4));
        mockV2.setManifestUploader(meta2, creator);
        mockV2.setManifestBlock(meta2, 90_000);
        vm.prank(creator);
        registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V2, meta2, 0, bytes32(0), 0, nft2));

        uint256[] memory ids = registry.collectionsByCreator(creator);
        assertEq(ids.length, 2);
    }

    // ═══════════════════════════ ANTI-GRIEF ═══════════════════════════

    function test_register_revertsForNonUploader_v2() public {
        vm.expectRevert(EVMFSCollectionRegistry.NotUploader.selector);
        _registerV2(rando, nft);
    }

    function test_register_revertsForNonUploader_v1() public {
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotUploader.selector);
        registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V1, METADATA_HASH, 100, bytes32(0), 0, nft));
    }

    function test_register_onChainDataUri_revertsForNonOwner() public {
        MockOwnable721 ownable = new MockOwnable721(creator);
        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.ON_CHAIN_DATA_URI,
            metadataManifest: bytes32(0),
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 1,
            nftContract: address(ownable),
            name: "X",
            symbol: "X"
        });
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotContractOwner.selector);
        registry.register(input);
    }

    function test_register_onChainDataUri_revertsForNonOwnable() public {
        // nft is just an EOA-shaped address; calling owner() reverts.
        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.ON_CHAIN_DATA_URI,
            metadataManifest: bytes32(0),
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 1,
            nftContract: nft,
            name: "X",
            symbol: "X"
        });
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotContractOwner.selector);
        registry.register(input);
    }

    function test_register_revertsWhenEvmfsKindWithNoManifest() public {
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.InvalidManifest.selector);
        registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V2, bytes32(0), 0, bytes32(0), 0, nft));
    }

    function test_register_revertsWhenOnchainKindWithManifest() public {
        MockOwnable721 ownable = new MockOwnable721(creator);
        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.ON_CHAIN_DATA_URI,
            metadataManifest: bytes32(uint256(0xfeed)), // illegal for non-EVMFS kind
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 1,
            nftContract: address(ownable),
            name: "X",
            symbol: "X"
        });
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.InvalidManifest.selector);
        registry.register(input);
    }

    function test_register_revertsWhenNftZero() public {
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.InvalidNftContract.selector);
        registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V2, METADATA_HASH, 0, bytes32(0), 0, address(0)));
    }

    function test_register_revertsWhenAlreadyRegistered() public {
        _registerV2(creator, nft);
        bytes32 meta2 = bytes32(uint256(0xd4));
        address creator2 = makeAddr("creator2");
        mockV2.setManifestUploader(meta2, creator2);
        mockV2.setManifestBlock(meta2, 80_000);
        vm.prank(creator2);
        vm.expectRevert(EVMFSCollectionRegistry.AlreadyRegistered.selector);
        registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V2, meta2, 0, bytes32(0), 0, nft));
    }

    // ═══════════════════════════ CURATED REGISTRATION ═══════════════════════════

    function test_registerCurated_bypassesAuthAndAttributesToCreator() public {
        // Hash was uploaded by creator on V1, but deployer registers on their behalf.
        EVMFSCollectionRegistry.RegistrationInput memory input = _evmfsInput(
            EVMFSCollectionRegistry.Kind.EVMFS_V1, METADATA_HASH, 71_118_217, bytes32(0), 0, nft
        );

        uint256 id = registry.registerCurated(input, creator);
        EVMFSCollectionRegistry.Collection memory c = registry.getCollection(id);
        assertEq(c.creator, creator);
        assertTrue(registry.verified(nft));
    }

    function test_registerCurated_revertsForNonOwner() public {
        EVMFSCollectionRegistry.RegistrationInput memory input = _evmfsInput(
            EVMFSCollectionRegistry.Kind.EVMFS_V1, METADATA_HASH, 71_118_217, bytes32(0), 0, nft
        );
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotOwner.selector);
        registry.registerCurated(input, creator);
    }

    function test_registerCurated_onNonOwnableContract() public {
        // No EVMFS upload, no Ownable: still works for the registry deployer.
        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.OFFCHAIN,
            metadataManifest: bytes32(0),
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 1,
            nftContract: nft,
            name: "Curated",
            symbol: "C"
        });
        uint256 id = registry.registerCurated(input, creator);
        assertEq(registry.getCollection(id).creator, creator);
    }

    // ═══════════════════════════ VERIFIED ═══════════════════════════

    function test_setVerified_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotOwner.selector);
        registry.setVerified(nft, true);
    }

    function test_setVerified_togglesAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit EVMFSCollectionRegistry.Verified(nft, true);
        registry.setVerified(nft, true);
        assertTrue(registry.verified(nft));

        registry.setVerified(nft, false);
        assertFalse(registry.verified(nft));
    }

    // ═══════════════════════════ TAGS ═══════════════════════════

    function test_setTags_byCreator() public {
        _registerV2(creator, nft);
        string[] memory tags = new string[](2);
        tags[0] = "art";
        tags[1] = "pixel";

        vm.expectEmit(true, false, false, true);
        emit EVMFSCollectionRegistry.TagsUpdated(1, tags);
        vm.prank(creator);
        registry.setTags(1, tags);

        string[] memory got = registry.getTags(1);
        assertEq(got.length, 2);
        assertEq(got[0], "art");
        assertEq(got[1], "pixel");
    }

    function test_setTags_byRegistryOwner() public {
        _registerV2(creator, nft);
        string[] memory tags = new string[](1);
        tags[0] = "featured";
        registry.setTags(1, tags); // deployer == registry owner
        assertEq(registry.getTags(1)[0], "featured");
    }

    function test_setTags_revertsForRando() public {
        _registerV2(creator, nft);
        string[] memory tags = new string[](1);
        tags[0] = "evil";
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotCreator.selector);
        registry.setTags(1, tags);
    }

    function test_setTags_revertsWhenTooMany() public {
        _registerV2(creator, nft);
        string[] memory tags = new string[](9);
        for (uint256 i; i < 9; ++i) tags[i] = "t";
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.TooManyTags.selector);
        registry.setTags(1, tags);
    }

    function test_setTags_revertsWhenTagTooLong() public {
        _registerV2(creator, nft);
        string[] memory tags = new string[](1);
        tags[0] = "this-tag-is-too-long-12345"; // 26 chars
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.TagTooLong.selector);
        registry.setTags(1, tags);
    }

    function test_setTags_revertsWhenEmpty() public {
        _registerV2(creator, nft);
        string[] memory tags = new string[](1);
        tags[0] = "";
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.TagTooLong.selector);
        registry.setTags(1, tags);
    }

    function test_setTags_replacesOldSet() public {
        _registerV2(creator, nft);
        string[] memory a = new string[](2);
        a[0] = "one";
        a[1] = "two";
        vm.prank(creator);
        registry.setTags(1, a);

        string[] memory b = new string[](1);
        b[0] = "three";
        vm.prank(creator);
        registry.setTags(1, b);

        string[] memory got = registry.getTags(1);
        assertEq(got.length, 1);
        assertEq(got[0], "three");
    }

    // ═══════════════════════════ OWNERSHIP ═══════════════════════════

    function test_transferOwnership() public {
        vm.expectEmit(true, true, false, true);
        emit EVMFSCollectionRegistry.OwnershipTransferred(deployer, creator);
        registry.transferOwnership(creator);
        assertEq(registry.owner(), creator);

        // old owner can no longer set verified
        vm.expectRevert(EVMFSCollectionRegistry.NotOwner.selector);
        registry.setVerified(nft, true);
    }

    function test_renounceOwnership() public {
        registry.renounceOwnership();
        assertEq(registry.owner(), address(0));
    }

    function test_transferOwnership_revertsForRando() public {
        vm.prank(rando);
        vm.expectRevert(EVMFSCollectionRegistry.NotOwner.selector);
        registry.transferOwnership(creator);
    }

    // ═══════════════════════════ UPDATES ═══════════════════════════

    function test_updateMetadata_v2_autoResolves() public {
        _registerV2(creator, nft);
        bytes32 newHash = bytes32(uint256(0xee));
        mockV2.setManifestUploader(newHash, creator);
        mockV2.setManifestBlock(newHash, 999);

        vm.prank(creator);
        registry.updateMetadata(1, newHash, 0);

        EVMFSCollectionRegistry.Collection memory c = registry.getCollection(1);
        assertEq(c.metadataManifest, newHash);
        assertEq(c.metadataBlock, 999);
    }

    function test_updateMetadata_offchain_isNoop() public {
        MockOwnable721 ownable = new MockOwnable721(creator);
        EVMFSCollectionRegistry.RegistrationInput memory input = EVMFSCollectionRegistry.RegistrationInput({
            kind: EVMFSCollectionRegistry.Kind.OFFCHAIN,
            metadataManifest: bytes32(0),
            metadataBlock: 0,
            indexManifest: bytes32(0),
            indexBlock: 0,
            totalSupply: 1,
            nftContract: address(ownable),
            name: "Pleb",
            symbol: "PLB"
        });
        vm.prank(creator);
        uint256 id = registry.register(input);

        // Passing non-zero values must revert for non-EVMFS kinds.
        vm.prank(creator);
        vm.expectRevert(EVMFSCollectionRegistry.InvalidManifest.selector);
        registry.updateMetadata(id, bytes32(uint256(0xbeef)), 0);

        // Zero values are accepted as a no-op.
        vm.prank(creator);
        registry.updateMetadata(id, bytes32(0), 0);
    }

    function test_updateTotalSupply() public {
        _registerV2(creator, nft);
        vm.prank(creator);
        registry.updateTotalSupply(1, 5000);
        assertEq(registry.getCollection(1).totalSupply, 5000);
    }

    // ═══════════════════════════ PAGINATION ═══════════════════════════

    function test_getCollections_pagination() public {
        for (uint256 i; i < 5; ++i) {
            bytes32 h = bytes32(uint256(0x100 + i));
            address n = address(uint160(0x1000 + i));
            mockV2.setManifestUploader(h, creator);
            mockV2.setManifestBlock(h, 100 + i);
            vm.prank(creator);
            registry.register(_evmfsInput(EVMFSCollectionRegistry.Kind.EVMFS_V2, h, 0, bytes32(0), 0, n));
        }

        EVMFSCollectionRegistry.Collection[] memory page = registry.getCollections(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0].metadataManifest, bytes32(uint256(0x101)));
        assertEq(page[1].metadataManifest, bytes32(uint256(0x102)));
    }

    function test_getCollection_revertsOnUnknownId() public {
        vm.expectRevert(EVMFSCollectionRegistry.CollectionNotFound.selector);
        registry.getCollection(42);
    }
}
