/* SPDX-License-Identifier: GPL-3.0-or-later */

import { expect, use } from "chai";
import { ethers } from "hardhat";
import { Signer, BigNumber, ContractTransaction } from "ethers";
import { RewardToken__factory, RewardToken, RewardTracker, RewardTracker__factory } from "../typechain-types";
import { solidity } from "ethereum-waffle";

use(solidity);

describe("RewardToken contract", function () {

    let traders: Signer[];
    let traderAddresses: string[];
    let owner: Signer;
    let rewardToken: RewardToken;
    let rewardTracker: RewardTracker;
    let timeZero: number;

    const day = 24 * 60 * 60;
    const month = 30 * day;
    const rewardNumerator = BigNumber.from(387).shl(112);
    const rewardDenominator = BigNumber.from(1000).shl(112);

    const txTimestamp = async (txPromise: Promise<ContractTransaction>): Promise<number> => {
        let tx = await txPromise;
        return blockTimestamp(tx.blockNumber!);
    }

    const blockTimestamp = async (blockNumber: any): Promise<number> => {
        if (typeof blockNumber == "number") {
            blockNumber = "0x" + blockNumber.toString(16)
        }

        const lastBlock = await ethers.provider.send("eth_getBlockByNumber", [blockNumber, true]);
        return lastBlock.timestamp;
    }

    const setTimestamp = (timestamp: number): Promise<void> => {
        return ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    }

    const lastBlockTimestamp = async (): Promise<number> => {
        const lastBlockNumber = await ethers.provider.send("eth_blockNumber", []);
        return blockTimestamp(lastBlockNumber);
    }

    const wait = async (seconds: number) => {
        await ethers.provider.send("evm_increaseTime", [seconds - 1]);
        await ethers.provider.send("evm_mine", []);
    }

    const setAutoMine = async (automine: boolean) => {
        await ethers.provider.send("evm_setAutomine", [automine]);
        if (automine) {
            await ethers.provider.send("evm_mine", []);
        }
    }

    beforeEach(async function () {
        [owner, ...traders] = await ethers.getSigners();
        traderAddresses = await Promise.all(traders.map(trader => trader.getAddress()))

        const rewardTokenFactory = (await ethers.getContractFactory("RewardToken", owner)) as RewardToken__factory;
        rewardToken = await rewardTokenFactory.deploy();

        const rewardTrackerFactory = (await ethers.getContractFactory("RewardTracker", owner)) as RewardTracker__factory;
        rewardTracker = await rewardTrackerFactory.deploy(rewardToken.address);

        await rewardToken.connect(owner).transferOwnership(rewardTracker.address);
        timeZero = (await rewardTracker.currentPeriodicity()).timeZero;
    });

    it("Claim after 0,1,2 periods", async function () {
        await wait(1 * day);
        const T1 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[0], BigNumber.from(100_000)));

        // period 1: too early to claim
        await wait(1 * day);
        expect(await rewardTracker.connect(traders[0]).claim())
            .to.emit(rewardTracker, "Claim")
            .withArgs(traderAddresses[0], BigNumber.from(0), BigNumber.from(0));
        expect(await rewardToken.balanceOf(traderAddresses[0]), "no reward").to.equal(0);

        // period 2: can claim for seconds up to period 2 start
        await wait(1 * month);
        const T2 = timeZero + (1 * month);
        const secondsT1_T2 = BigNumber.from(T2 - T1);
        const tx2 = await rewardTracker.connect(traders[0]).claim()
        const rewardT1_T2 = await rewardToken.balanceOf(traderAddresses[0]);
        const rewardT1_T2Expected = secondsT1_T2.mul(rewardNumerator).div(rewardDenominator);
        expect(tx2).to.emit(rewardTracker, "Claim")
            .withArgs(traderAddresses[0], rewardT1_T2, rewardT1_T2);
        expect(rewardT1_T2, "rewardT1_T2").to.be.closeTo(rewardT1_T2Expected, 1);

        const T3 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[0], BigNumber.from(10_000)));
        const secondsT2_T3 = BigNumber.from(T3 - T2);

        // now can claim for seconds from period 2 start to T3
        await rewardTracker.connect(traders[0]).claim();
        const rewardT1_T3 = await rewardToken.balanceOf(traderAddresses[0]);
        const rewardT2_T3Expected = secondsT2_T3.mul(rewardNumerator).div(rewardDenominator);
        const rewardT1_T3Expected = rewardT1_T2Expected.add(rewardT2_T3Expected);
        expect(rewardT1_T3, "rewardT1_T3").to.be.closeTo(rewardT1_T3Expected, 2);

        // not nothing to claim
        await wait(1 * day);
        await rewardTracker.connect(traders[0]).claim();
        expect(await rewardToken.balanceOf(traderAddresses[0]), "unchanged reward").to.equal(rewardT1_T3);

        // period 3
        const T4 = timeZero + (2 * month);
        const secondsT3_T4 = BigNumber.from(T4 - T3);

        // period 4
        await wait(1 * month);
        await rewardTracker.connect(traders[0]).claim();
        const rewardT1_T4 = await rewardToken.balanceOf(traderAddresses[0]);
        const rewardT3_T4Expected = secondsT3_T4.mul(rewardNumerator).div(rewardDenominator);
        const rewardT1_T4Expected = rewardT1_T3Expected.add(rewardT3_T4Expected);
        expect(rewardT1_T4, "rewardT1_T4").to.be.closeTo(rewardT1_T4Expected, 3);
    });


    it("Shares for multiple traders", async function () {
        // period 1
        const T1 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[0], BigNumber.from(100_000)));
        const trader0T1_T3 = BigNumber.from(100_000);

        await wait(1 * day);
        const T2 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(200_000)));
        const secondsT1_T2 = BigNumber.from(T2 - T1);
        const marketT1_T2 = BigNumber.from(100_000);

        // period 2
        await wait(1 * month);
        const tx3 = rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(-50_000));
        const T3 = await txTimestamp(tx3);
        await rewardTracker.connect(traders[1]).claim();
        const trader1RewardIntermediate = await rewardToken.balanceOf(traderAddresses[1]);
        expect(await tx3).to.emit(rewardTracker, "Trade")
            .withArgs(await owner.getAddress(), traderAddresses[1], BigNumber.from(-50_000), trader1RewardIntermediate);
        const secondsT2_T3 = BigNumber.from(T3 - T2);
        const marketT2_T3 = BigNumber.from(100_000 + 200_000);
        const trader1T2_T3 = BigNumber.from(200_000);

        // period 3
        await wait(1 * month);
        const T4 = timeZero + (2 * month);
        const secondsT3_T4 = BigNumber.from(T4 - T3);
        const marketT3_T4 = BigNumber.from(50_000);
        const trader1T3_T4 = BigNumber.from(50_000);
        await rewardTracker.connect(traders[0]).claim();
        const trader0Reward = await rewardToken.balanceOf(traderAddresses[0]);

        //period 4
        await wait(1 * month);
        await rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(-100_000));

        await wait(1 * day);
        await rewardTracker.connect(traders[1]).claim();
        const trader1Reward = await rewardToken.balanceOf(traderAddresses[1]);

        // check rewards
        const trader0RewardT1_T2 = secondsT1_T2.mul(trader0T1_T3.mul(rewardNumerator).div(marketT1_T2)).div(rewardDenominator);
        const trader0RewardT2_T3 = secondsT2_T3.mul(trader0T1_T3.mul(rewardNumerator).div(marketT2_T3)).div(rewardDenominator);
        const trader0RewardExpected = trader0RewardT1_T2.add(trader0RewardT2_T3);
        expect(trader0Reward, "Trader 0 reward").to.be.closeTo(trader0RewardExpected, 2);

        const trader1RewardT2_T3 = secondsT2_T3.mul(trader1T2_T3.mul(rewardNumerator).div(marketT2_T3)).div(rewardDenominator);
        const trader1RewardT3_T4 = secondsT3_T4.mul(trader1T3_T4.mul(rewardNumerator).div(marketT3_T4)).div(rewardDenominator);
        const trader1RewardExpected = trader1RewardT2_T3.add(trader1RewardT3_T4);
        expect(trader1Reward, "Trader 1 reward").to.be.closeTo(trader1RewardExpected, 2);
    })


    it("Transactions on first second of a period; various periods", async function () {
        const period1 = month
        const period2 = 3 * month
        const period3 = 5 * day

        // period 1
        expect(await rewardTracker.connect(owner).setPeriodDuration(period2))
            .to.emit(rewardTracker, "PeriodChangeRequested"); // will be effective for next periods

        const T1 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[0], BigNumber.from(100_000)));
        const trader0T1_T3 = BigNumber.from(100_000);

        await wait(1 * day);
        const T2 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(200_000)));
        const secondsT1_T2 = BigNumber.from(T2 - T1);
        const marketT1_T2 = BigNumber.from(100_000);

        expect((await rewardTracker.currentPeriodicity()).periodDuration, "period1 effective").to.be.equals(period1);

        // period 2
        await setTimestamp(timeZero + period1);
        expect(await rewardTracker.connect(owner).setPeriodDuration(period3))
            .to.emit(rewardTracker, "PeriodChanged")
            .withArgs(timeZero, period1, timeZero + period1, period2);
        expect((await rewardTracker.currentPeriodicity()).periodDuration, "period2 effective").to.be.equals(period2);

        const T3 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(-50_000)));
        const secondsT2_T3 = BigNumber.from(T3 - T2);
        const marketT2_T3 = BigNumber.from(100_000 + 200_000);
        const trader1T2_T3 = BigNumber.from(200_000);

        // period 3
        const T4 = timeZero + period1 + period2;
        await setTimestamp(T4);
        const secondsT3_T4 = BigNumber.from(T4 - T3);
        const marketT3_T4 = BigNumber.from(50_000);
        const trader1T3_T4 = BigNumber.from(50_000);
        expect(await rewardTracker.connect(traders[0]).claim())
            .to.emit(rewardTracker, "PeriodChanged")
            .withArgs(timeZero + period1, period2, timeZero + period1 + period2, period3);
        const trader0Reward = await rewardToken.balanceOf(traderAddresses[0]);

        //period 4
        await setTimestamp(timeZero + period1 + period2 + period3);
        await rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(-100_000));

        await wait(1 * day);
        await rewardTracker.connect(traders[1]).claim();
        const trader1Reward = await rewardToken.balanceOf(traderAddresses[1]);

        // check rewards
        const trader0RewardT1_T2 = secondsT1_T2.mul(trader0T1_T3.mul(rewardNumerator).div(marketT1_T2)).div(rewardDenominator);
        const trader0RewardT2_T3 = secondsT2_T3.mul(trader0T1_T3.mul(rewardNumerator).div(marketT2_T3)).div(rewardDenominator);
        const trader0RewardExpected = trader0RewardT1_T2.add(trader0RewardT2_T3);
        expect(trader0Reward, "Trader 0 reward").to.be.closeTo(trader0RewardExpected, 2);

        const trader1RewardT2_T3 = secondsT2_T3.mul(trader1T2_T3.mul(rewardNumerator).div(marketT2_T3)).div(rewardDenominator);
        const trader1RewardT3_T4 = secondsT3_T4.mul(trader1T3_T4.mul(rewardNumerator).div(marketT3_T4)).div(rewardDenominator);
        const trader1RewardExpected = trader1RewardT2_T3.add(trader1RewardT3_T4);
        expect(trader1Reward, "Trader 1 reward").to.be.closeTo(trader1RewardExpected, 2);
    })

    it("Example case", async function () {
        // period 1
        const T1 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(100_000)));
        const trader1T1_T5 = BigNumber.from(100_000);
        const marketT1_T2 = BigNumber.from(100_000);

        await wait(1 * day);
        const T2 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[2], BigNumber.from(50_000)));
        const trader2T2_T4 = BigNumber.from(50_000);
        const marketT2_T3 = BigNumber.from(150_000);
        const secondsT1_T2 = BigNumber.from(T2 - T1);

        await wait(1 * day);
        const T3 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[3], BigNumber.from(100_000)));
        const trader3T3_T5 = BigNumber.from(100_000);
        const marketT3_T4 = BigNumber.from(250_000);
        const secondsT2_T3 = BigNumber.from(T3 - T2);

        await wait(1 * day);
        const T4 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[2], BigNumber.from(-25_000)));
        const trader2T4_T5 = BigNumber.from(75_000);
        const marketT4_T5 = BigNumber.from(275_000);
        const secondsT3_T4 = BigNumber.from(T4 - T3);

        // period 2
        await wait(1 * month);
        const T5 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[4], BigNumber.from(100_000)));
        const trader4T5_T7 = BigNumber.from(100_000);
        const marketT5_T6 = BigNumber.from(100_000);
        const secondsT4_T5 = BigNumber.from(T5 - T4);

        await wait(1 * day);
        const T6 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[2], BigNumber.from(-25_000)));
        const trader2T6_T7 = BigNumber.from(25_000);
        const marketT6_T7 = BigNumber.from(125_000);
        const secondsT5_T6 = BigNumber.from(T6 - T5);

        // period 3
        await wait(1 * month);
        const T7 = await txTimestamp(
            rewardTracker.connect(owner).onTrade(traderAddresses[1], BigNumber.from(-100_000)));
        const trader1T7_T8 = BigNumber.from(100_000);
        const marketT7_T8 = BigNumber.from(100_000);
        const secondsT6_T7 = BigNumber.from(T7 - T6);

        // period 4
        const T8 = timeZero + (3 * month);
        const secondsT7_T8 = BigNumber.from(T8 - T7);

        // period 5
        await wait(2 * month);
        await setAutoMine(false);
        const tx9_1 = await rewardTracker.connect(traders[1]).claim();
        const tx9_2 = await rewardTracker.connect(traders[2]).claim();
        const tx9_3 = await rewardTracker.connect(traders[3]).claim();
        const tx9_4 = await rewardTracker.connect(traders[4]).claim();
        await setAutoMine(true);
        const tx9Blocks = new Set([(await tx9_1.wait(1)).blockNumber, (await tx9_2.wait(1)).blockNumber, (await tx9_3.wait(1)).blockNumber, (await tx9_4.wait(1)).blockNumber]);
        expect(tx9Blocks.size, "All claim transactions are in the same block").to.be.equals(1);
        expect(tx9Blocks, "Claim transactions block is mined").does.not.include(null);
        const trader1Reward = await rewardToken.balanceOf(traderAddresses[1]);
        const trader2Reward = await rewardToken.balanceOf(traderAddresses[2]);
        const trader3Reward = await rewardToken.balanceOf(traderAddresses[3]);
        const trader4Reward = await rewardToken.balanceOf(traderAddresses[4]);

        // check rewards
        const trader1RewardT1_T2 = secondsT1_T2.mul(trader1T1_T5.mul(rewardNumerator).div(marketT1_T2)).div(rewardDenominator);
        const trader1RewardT2_T3 = secondsT2_T3.mul(trader1T1_T5.mul(rewardNumerator).div(marketT2_T3)).div(rewardDenominator);
        const trader1RewardT3_T4 = secondsT3_T4.mul(trader1T1_T5.mul(rewardNumerator).div(marketT3_T4)).div(rewardDenominator);
        const trader1RewardT4_T5 = secondsT4_T5.mul(trader1T1_T5.mul(rewardNumerator).div(marketT4_T5)).div(rewardDenominator);
        const trader1RewardT7_T8 = secondsT7_T8.mul(trader1T7_T8.mul(rewardNumerator).div(marketT7_T8)).div(rewardDenominator);
        const trader1RewardExpected = trader1RewardT1_T2.add(trader1RewardT2_T3).add(trader1RewardT3_T4).add(trader1RewardT4_T5).add(trader1RewardT7_T8);
        expect(trader1Reward, "Trader 1 reward").to.be.closeTo(trader1RewardExpected, 5);

        const trader2RewardT2_T3 = secondsT2_T3.mul(trader2T2_T4.mul(rewardNumerator).div(marketT2_T3)).div(rewardDenominator);
        const trader2RewardT3_T4 = secondsT3_T4.mul(trader2T2_T4.mul(rewardNumerator).div(marketT3_T4)).div(rewardDenominator);
        const trader2RewardT4_T5 = secondsT4_T5.mul(trader2T4_T5.mul(rewardNumerator).div(marketT4_T5)).div(rewardDenominator);
        const trader2RewardT6_T7 = secondsT6_T7.mul(trader2T6_T7.mul(rewardNumerator).div(marketT6_T7)).div(rewardDenominator);
        const trader2RewardExpected = trader2RewardT2_T3.add(trader2RewardT3_T4).add(trader2RewardT4_T5).add(trader2RewardT6_T7);
        expect(trader2Reward, "Trader 2 reward").to.be.closeTo(trader2RewardExpected, 4);

        const trader3RewardT3_T4 = secondsT3_T4.mul(trader3T3_T5.mul(rewardNumerator).div(marketT3_T4)).div(rewardDenominator);
        const trader3RewardT4_T5 = secondsT4_T5.mul(trader3T3_T5.mul(rewardNumerator).div(marketT4_T5)).div(rewardDenominator);
        const trader3RewardExpected = trader3RewardT3_T4.add(trader3RewardT4_T5);
        expect(trader3Reward, "Trader 3 reward").to.be.closeTo(trader3RewardExpected, 2);

        const trader4RewardT5_T6 = secondsT5_T6.mul(trader4T5_T7.mul(rewardNumerator).div(marketT5_T6)).div(rewardDenominator);
        const trader4RewardT6_T7 = secondsT6_T7.mul(trader4T5_T7.mul(rewardNumerator).div(marketT6_T7)).div(rewardDenominator);
        const trader4RewardExpected = trader4RewardT5_T6.add(trader4RewardT6_T7);
        expect(trader4Reward, "Trader 4 reward").to.be.closeTo(trader4RewardExpected, 2);

    })
});
