// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockERC721WithRoyalty is ERC721, ERC2981, Ownable {
    uint256 private _nextTokenId = 1;

    constructor(address royaltyReceiver, uint96 royaltyBps)
        ERC721("MockRoyaltyNFT", "MRNFT")
        Ownable(msg.sender)
    {
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _mint(to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
