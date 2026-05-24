// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library FeeMath {
    uint16 internal constant PROTOCOL_FEE_BPS = 50; // 0.5% = 50 basis points
    uint16 internal constant MAX_BPS = 10_000;

    struct FeeBreakdown {
        uint256 protocolFee;
        uint256 royaltyAmount;
        address royaltyReceiver;
        uint256 sellerProceeds;
    }

    /// @notice Calculate the protocol fee for a given sale price.
    /// @param salePrice The total sale price in wei.
    /// @return The protocol fee in wei.
    function calculateProtocolFee(uint256 salePrice) internal pure returns (uint256) {
        return (salePrice * PROTOCOL_FEE_BPS) / MAX_BPS;
    }

    /// @notice Calculate an optional royalty amount from basis points.
    /// @param salePrice The total sale price in wei.
    /// @param bps The royalty in basis points (0-10000).
    /// @return The royalty amount in wei.
    function calculateRoyalty(uint256 salePrice, uint16 bps) internal pure returns (uint256) {
        if (bps == 0) return 0;
        return (salePrice * bps) / MAX_BPS;
    }

    /// @notice Calculate the full fee breakdown for a sale.
    /// @param salePrice Total sale price.
    /// @param erc2981Royalty Royalty amount from ERC-2981 (0 if not supported).
    /// @param erc2981Receiver Royalty receiver from ERC-2981 (address(0) if not supported).
    /// @param optionalRoyaltyBps Additional buyer-chosen royalty in bps.
    /// @param fallbackRoyaltyReceiver Fallback receiver for optional royalty if no ERC-2981 receiver.
    /// @return breakdown The complete fee breakdown.
    function calculateFees(
        uint256 salePrice,
        uint256 erc2981Royalty,
        address erc2981Receiver,
        uint16 optionalRoyaltyBps,
        address fallbackRoyaltyReceiver
    ) internal pure returns (FeeBreakdown memory breakdown) {
        breakdown.protocolFee = calculateProtocolFee(salePrice);

        // ERC-2981 royalty
        breakdown.royaltyReceiver = erc2981Receiver;
        breakdown.royaltyAmount = erc2981Royalty;

        // Optional additional royalty
        if (optionalRoyaltyBps > 0) {
            uint256 optionalRoyalty = calculateRoyalty(salePrice, optionalRoyaltyBps);
            if (breakdown.royaltyReceiver == address(0)) {
                // No ERC-2981 receiver — use fallback (collection owner)
                if (fallbackRoyaltyReceiver != address(0)) {
                    breakdown.royaltyReceiver = fallbackRoyaltyReceiver;
                    breakdown.royaltyAmount = optionalRoyalty;
                }
                // If no fallback either, skip optional royalty
            } else {
                // Add on top of ERC-2981 royalty, same receiver
                breakdown.royaltyAmount += optionalRoyalty;
            }
        }

        // Cap: ensure fees don't exceed sale price
        if (breakdown.protocolFee + breakdown.royaltyAmount > salePrice) {
            breakdown.royaltyAmount = salePrice - breakdown.protocolFee;
        }

        breakdown.sellerProceeds = salePrice - breakdown.protocolFee - breakdown.royaltyAmount;
    }
}
