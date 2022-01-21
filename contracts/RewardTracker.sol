/* SPDX-License-Identifier: GPL-3.0-or-later */
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./RewardToken.sol";

/*
    Trades are registered by contract owner with onTrade() function.
    Also this function increases pending reward for the trader taking into account all periods including current one.

    Claims are done by traders with claim() function. The function mints RewardToken.
    Before minting the function increases pending reward for the trader not taking into account
    current period. Current period is not processed because claim is not considered as a trade, and it is unknown if the user
    will receive reward for the current period.

    Period duration can be changed by contract owner with setPeriodDuration() function.
    The change is not applied immediately, it only affects periods after current one.

    Time is processed as uint32, it is enough till year 2106. It helps to pack more fields into one storage slot and save some gas.
    Notional is processed as uint112, it allows to multiply
        (tradingVolume: uint112) * (timeInterval: uint32) * (2^112 / marketVolume: uint112)
    without overflow. Overflows in 'add' operation is still possible, but it is much less probable if all arguments are limited.
 */
contract RewardTracker is Ownable {
    constructor(RewardToken rewardToken) {
        currentPeriodicity = Periodicity(SafeCast.toUint32(block.timestamp), initialPeriodDuration);
        token = rewardToken;
    }

    struct TraderDatum {
        uint144 pendingReward;
        uint112 lastTradingVolume;
        uint144 lastWeightenedSeconds;
        uint32 lastTradePeriodEnd;
    }

    struct Periodicity {
        uint32 timeZero;
        uint32 periodDuration;
    }

    event Claim(address indexed trader, uint rewardGranted, uint rewardMinted);
    event Trade(address indexed sender, address indexed trader, int notional, uint rewardGranted);
    event PeriodChangeRequested(address indexed sender, uint32 timeZero, uint32 periodDuration);
    event PeriodChanged(uint32 oldTimeZero, uint32 oldPeriodDuration, uint32 newTimeZero, uint32 newPeriodDuration);

    RewardToken immutable public token;
    uint32 constant initialPeriodDuration = 30 * 24 * 60 * 60; // 30 days
    uint constant notionalLimit = 1 << 112;
    uint constant totalRewardPerSecondNumerator = 387;
    uint constant totalRewardPerSecondDenominator = 1000;

    mapping(/*trader*/address => TraderDatum) public traderData;
    mapping(/*periodStartTime*/uint32 => /*weightenedSeconds*/uint144) private weightenedSecondsByPeriod;

    uint144 private weightenedSeconds; // cumulative sum of [seconds * 2^112 / marketVolume]
    uint112 private lastMarketVolume;
    Periodicity private desiredPeriodicity;
    Periodicity public currentPeriodicity;
    uint32 private lastTradeTime;
    uint32 private lastTradePeriodEnd;

    function setPeriodDuration(uint32 periodDuration) onlyOwner external {
        require(periodDuration > 0, "Period duration is 0");
        (, uint32 currentPeriodEnd) = currentPeriodBoundaries();
        desiredPeriodicity = Periodicity(currentPeriodEnd, periodDuration);
        emit PeriodChangeRequested(_msgSender(), currentPeriodEnd, periodDuration);
    }

    function onTrade(address trader, int notional) onlyOwner external {
        require(notional != 0, "Notional value is 0");
        (uint32 currentPeriodStart, uint32 currentPeriodEnd) = currentPeriodBoundaries();
        uint notionalAbs;
        if (notional >= 0) {
            notionalAbs = uint(notional);
        } else {
            notionalAbs = uint(-notional);
        }
        require(notionalAbs < notionalLimit, "Notional value exceeds the limit");
        updateMarketVolume(uint112(notionalAbs), currentPeriodStart, currentPeriodEnd);
        uint rewardGranted = updateTradeVolume(trader, uint112(notionalAbs), currentPeriodStart, currentPeriodEnd);
        emit Trade(_msgSender(), trader, notional,  rewardGranted);
    }

    function claim() external {
        address trader = _msgSender();
        TraderDatum storage traderDatum = traderData[trader];
        require(traderDatum.lastTradePeriodEnd > 0, "Not a trader");

        (uint32 currentPeriodStart, ) = currentPeriodBoundaries();
        uint32 _lastTradePeriodEnd = traderDatum.lastTradePeriodEnd;
        uint reward = traderDatum.pendingReward;
        uint rewardGranted = 0;

        if (currentPeriodStart >= _lastTradePeriodEnd) {
            // it is safe to add latest pendingReward if trade period is in past already
            uint144 _weightenedSeconds = weightenedSecondsByPeriod[_lastTradePeriodEnd];
            if (_weightenedSeconds == 0) {
                // no trading on the market since trader's last period
                uint secondsToTradePeriodEnd = lastTradePeriodEnd - lastTradeTime;
                _weightenedSeconds = weightenedSeconds + uint144((secondsToTradePeriodEnd * notionalLimit) / lastMarketVolume);
            }
            uint144 secondsToMarketVolume = _weightenedSeconds - traderDatum.lastWeightenedSeconds;
            rewardGranted = computeReward(traderDatum.lastTradingVolume, secondsToMarketVolume);
            reward += rewardGranted;
            traderDatum.lastWeightenedSeconds = _weightenedSeconds;
        }

        traderDatum.pendingReward = 0;
        emit Claim(trader, rewardGranted, reward);
        token.mint(trader, reward);
    }

    function updateMarketVolume(uint112 notionalAbs, uint32 currentPeriodStart, uint32 currentPeriodEnd) private {
        uint32 _lastTradePeriodEnd = lastTradePeriodEnd;

        if (lastMarketVolume > 0) {
            uint32 endTime = SafeCast.toUint32(block.timestamp);
            if (currentPeriodStart > _lastTradePeriodEnd) {
                endTime = _lastTradePeriodEnd;
            }
            uint secondsSinceLastTrade = endTime - lastTradeTime;
            weightenedSeconds += uint144((secondsSinceLastTrade * notionalLimit) / lastMarketVolume);
            if (currentPeriodStart > _lastTradePeriodEnd) {
                if (weightenedSecondsByPeriod[_lastTradePeriodEnd] == 0) {
                    weightenedSecondsByPeriod[_lastTradePeriodEnd] = weightenedSeconds;
                }
            }
        }

        if (weightenedSecondsByPeriod[currentPeriodStart] == 0) {
            weightenedSecondsByPeriod[currentPeriodStart] = weightenedSeconds;
        }

        if (currentPeriodStart < _lastTradePeriodEnd) {
            lastMarketVolume += notionalAbs;
        } else {
            lastMarketVolume = notionalAbs;
        }

        lastTradeTime = SafeCast.toUint32(block.timestamp);
        lastTradePeriodEnd = currentPeriodEnd;
    }

    function updateTradeVolume(address trader, uint112 notionalAbs, uint32 currentPeriodStart, uint32 currentPeriodEnd) private returns(uint) {
        TraderDatum storage traderDatum = traderData[trader];
        uint32 _lastTradePeriodEnd = traderDatum.lastTradePeriodEnd;
        uint144 _weightenedSeconds = weightenedSeconds;

        uint144 secondsToMarketVolume;

        if (currentPeriodStart < _lastTradePeriodEnd) {
            secondsToMarketVolume = _weightenedSeconds - traderDatum.lastWeightenedSeconds;
        } else {
            secondsToMarketVolume = weightenedSecondsByPeriod[_lastTradePeriodEnd] - traderDatum.lastWeightenedSeconds;
        }

        uint144 rewardGranted = computeReward(traderDatum.lastTradingVolume, secondsToMarketVolume);
        if (rewardGranted > 0) {
            traderDatum.pendingReward += rewardGranted;
        }

        if (currentPeriodStart < _lastTradePeriodEnd) {
            traderDatum.lastTradingVolume += notionalAbs;
        } else {
            traderDatum.lastTradingVolume = notionalAbs;
        }

        traderDatum.lastWeightenedSeconds = _weightenedSeconds;
        traderDatum.lastTradePeriodEnd = currentPeriodEnd;
        return rewardGranted;
    }

    function computeReward(uint112 lastTradingVolume, uint144 secondsToMarketVolume) private pure returns (uint144) {
        uint rewardShare = (/* 112 + 144 bits max, so never overflows */ uint(lastTradingVolume) * secondsToMarketVolume) / notionalLimit;
        return uint144((rewardShare * totalRewardPerSecondNumerator) / totalRewardPerSecondDenominator);
    }

    function currentPeriodBoundaries() private returns (uint32, uint32) {
        (Periodicity memory _desiredPeriodicity, Periodicity memory periodicity) = (desiredPeriodicity, currentPeriodicity);

        if (_desiredPeriodicity.periodDuration > 0 && _desiredPeriodicity.timeZero <= block.timestamp) {
            emit PeriodChanged(periodicity.timeZero, periodicity.periodDuration, _desiredPeriodicity.timeZero, _desiredPeriodicity.periodDuration);
            desiredPeriodicity = Periodicity(0, 0);
            currentPeriodicity = periodicity = _desiredPeriodicity;
        }

        uint32 period = (SafeCast.toUint32(block.timestamp) - periodicity.timeZero) / periodicity.periodDuration;
        uint32 periodStartInclusive = (period * periodicity.periodDuration) + periodicity.timeZero;
        uint32 periodEndExclusive = ((period + 1) * periodicity.periodDuration) + periodicity.timeZero;
        return (periodStartInclusive, periodEndExclusive);
    }
}
