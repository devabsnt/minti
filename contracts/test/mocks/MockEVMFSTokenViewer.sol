// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Trivial stand-in for EVMFSTokenViewer. Returns a deterministic
/// pseudo-URI built from the inputs so tests can assert delegation happened.
contract MockEVMFSTokenViewer {
    function tokenURI(bytes32 manifestHash, uint64 manifestBlock, uint256 tokenId)
        external
        pure
        returns (string memory)
    {
        // "evmfs://<hash>/<block>/<id>" — enough to verify the call was made.
        return string(
            abi.encodePacked(
                "evmfs://",
                _toHex(manifestHash),
                "/",
                _toDec(uint256(manifestBlock)),
                "/",
                _toDec(tokenId)
            )
        );
    }

    function _toHex(bytes32 x) private pure returns (string memory) {
        bytes16 alphabet = 0x30313233343536373839616263646566;
        bytes memory out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(x[i]);
            out[2 * i] = alphabet[b >> 4];
            out[2 * i + 1] = alphabet[b & 0xf];
        }
        return string(out);
    }

    function _toDec(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        uint256 t = v;
        while (t != 0) {
            digits++;
            t /= 10;
        }
        bytes memory out = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            out[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(out);
    }
}
