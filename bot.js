const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const {Connection, PublicKey, LAMPORTS_PER_SOL} = require('@solana/web3.js');
require('dotenv').config();


const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});

const slotTimeAvgSeconds = 0.400
const autoDeleteTimer = 60_000

let currentEpoch = null;
let rewardsMap = new Map();

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const validatorName = process.env.VALIDATOR_NAME ? process.env.VALIDATOR_NAME : "Operators";
    const welcomeMessage = `👋 Welcome ${validatorName}!\n\nPlease choose an option below:`;

    bot.sendMessage(chatId, welcomeMessage, {
        reply_markup: {
            inline_keyboard: [
                [
                    {text: "🔄 Stake Changes", callback_data: "stakeChanges"},
                    {text: "📊 Ranking", callback_data: "ranking"}
                ],
                [
                    {text: "ℹ️ Epoch Infos", callback_data: "epochInfos"},
                    {text: "🎁 Rewards", callback_data: "rewards"}
                ],
                [
                    {text: "💰 Balances", callback_data: "balances"}
                ]
            ]
        }
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const command = query.data;
    await bot.answerCallbackQuery(query.id);

    if (command === "balances") {
        try {
            const connection = new Connection(process.env.RPC_URL)

            const identityBalance = await connection.getBalance(new PublicKey(process.env.IDENTITY_ADDRESS))
            const voteBalance = await connection.getBalance(new PublicKey(process.env.VOTE_ADDRESS))

            bot.sendMessage(chatId, `Identity Balance: ${(identityBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\nVote Balance: ${(voteBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`).then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        } catch (e) {
            console.log(e)
            bot.sendMessage(chatId, "Error: the action couldn't be processed!").then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        }
    }

    if (command === "rewards") {
        try {
            const connection = new Connection(process.env.RPC_URL)
            const leaderSchedule = await connection.getLeaderSchedule()
            const epochInfo = await connection.getEpochInfo()
            const leaderSlots = leaderSchedule[process.env.IDENTITY_ADDRESS] || []
            const baseSlot = epochInfo.absoluteSlot - epochInfo.slotIndex

            const epochBuffer = Buffer.alloc(8); // allocate 8 bytes for u64
            epochBuffer.writeBigUInt64LE(BigInt(epochInfo.epoch));

            const [mevCollector] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("TIP_DISTRIBUTION_ACCOUNT"),
                    new PublicKey(process.env.VOTE_ADDRESS).toBuffer(),
                    epochBuffer,
                ],
                new PublicKey("4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7")
            )

            const mevBalance = await connection.getBalance(mevCollector)

            if (epochInfo.epoch !== currentEpoch) {
                currentEpoch = epochInfo.epoch
                rewardsMap.clear()
                leaderSlots.filter((slotIndex) => {
                    rewardsMap.set(slotIndex + baseSlot, 0)
                })
            }

            const rewards = await Promise.all(Array.from(rewardsMap).filter(([key, _value]) => key < epochInfo.slotIndex + baseSlot).map(async ([key, value]) => {
                if (value === 0) {
                    try {
                        const slotInfo = await connection.getBlock(key, {
                            rewards: true,
                            maxSupportedTransactionVersion: 0,
                            transactionDetails: "none"
                        })
                        return {slot: key, rewards: (slotInfo?.rewards[0]?.lamports || 0) / 10 ** 9}
                    } catch (e) {
                        return {slot: key, rewards: 0}
                    }
                }
                return {slot: key, rewards: value}
            }))
            rewards.forEach((item) => {
                rewardsMap.set(item.slot, item.rewards)
            })

            const totalRewards = rewards.reduce((curr, prev) => curr + prev.rewards, 0)

            const failedSlots = rewards.filter((item) => item.rewards === 0)
            const bestSlots = rewards
                .sort((a, b) => b.rewards - a.rewards) // Sort by rewards in descending order
                .slice(0, 50); // Take the top 50

            const firstLines = ["Best Slots:"].concat(bestSlots.map(item => `${item.slot}: ${item.rewards.toFixed(4)} SOL`)).concat(`\nFailed Slots:`).concat(failedSlots.map(item => `${item.slot}: ${item.rewards.toFixed(4)} SOL`))

            const message = firstLines.join('\n').concat(`\n\nTotal BR: ${totalRewards.toFixed(4)} SOL`).concat(`\nAvg Rewards/Slot: ${(totalRewards / rewards.filter((obj) => obj.rewards > 0).length).toFixed(4)} SOL`).concat(`\n\nTotal MEV: ${(mevBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`).concat(`\nAvg MEV/Slot: ${(mevBalance / LAMPORTS_PER_SOL / rewards.filter((obj) => obj.rewards > 0).length).toFixed(4)} SOL`)
            bot.sendMessage(chatId, message).then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        } catch (e) {
            console.log(e)
            bot.sendMessage(chatId, "Error: the action couldn't be processed!").then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        }
    }

    if (command === "epochInfos") {
        try {
            const response = await fetch("https://api.stakewiz.com/epoch_info");
            if (!response.ok) {
                throw new Error("Failed to fetch data");
            }
            const data = await response.json();
            const connection = new Connection(process.env.RPC_URL)
            const leaderSchedule = await connection.getLeaderSchedule()
            const epochInfo = await connection.getEpochInfo()
            const actualSlot = epochInfo.slotIndex
            const leaderSlots = leaderSchedule[process.env.IDENTITY_ADDRESS] || []
            const nextSlot = findSmallestGreaterThanX(leaderSlots, actualSlot)
            bot.sendMessage(chatId, `Epoch: ${data.epoch}\nLeader Slots: ${leaderSlots?.length || 0}\nRemaining Slots: ${leaderSlots.filter(num => num > actualSlot).length}\nNext Slot in: ~${formatSeconds(parseInt((nextSlot - actualSlot) * slotTimeAvgSeconds))}\nRemaining Time: ${formatSeconds(data.remaining_seconds)}\n`).then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        } catch (e) {
            console.log(e)
            bot.sendMessage(chatId, "Error: the action couldn't be processed!").then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        }
    }

    if (command === "ranking") {
        try {
            const response = await fetch(`https://api.stakewiz.com/validator/${process.env.VOTE_ADDRESS}`);
            if (!response.ok) {
                throw new Error("Failed to fetch data").then((sentMessage) => {
                    const messageId = sentMessage.message_id;
                    setTimeout(() => {
                        bot.deleteMessage(chatId, messageId);
                    }, autoDeleteTimer);
                });
            }
            const data = await response.json();
            bot.sendMessage(chatId, `Rank: ${data.rank}\nWiz Score: ${data.wiz_score}%\nVote Success: ${data.vote_success}%\nSkip rate: ${data.skip_rate.toFixed(2)}%\n`).then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        } catch (e) {
            console.log(e)
            bot.sendMessage(chatId, "Error: the action couldn't be processed!").then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        }
    }

    if (command === "stakeChanges") {
        try {
            const connection = new Connection(process.env.RPC_URL)
            const epochInfo = await connection.getEpochInfo()

            const stakedAccounts = await connection.getParsedProgramAccounts(
                new PublicKey("Stake11111111111111111111111111111111111111"),
                {
                    filters: [
                        {
                            memcmp: {
                                offset: 124,
                                bytes: process.env.VOTE_ADDRESS,
                            },
                        },
                    ],
                }
            )

            const activatingAccounts = stakedAccounts.filter(
                (stakedAccount) =>
                    Number(
                        stakedAccount.account.data.parsed.info.stake.delegation.activationEpoch
                    ) >= epochInfo.epoch &&
                    Number(
                        stakedAccount.account.data.parsed.info.stake.delegation
                            .deactivationEpoch
                    ) === Number("18446744073709551615")
            );

            const deactivatingAccounts = stakedAccounts.filter(
                (stakedAccount) =>
                    Number(
                        stakedAccount.account.data.parsed.info.stake.delegation.activationEpoch
                    ) < epochInfo.epoch &&
                    Number(
                        stakedAccount.account.data.parsed.info.stake.delegation
                            .deactivationEpoch
                    ) === epochInfo.epoch
            );

            let activating = activatingAccounts.map((obj) => {
                return {
                    amount: (obj.account.data.parsed.info.stake.delegation.stake
                        / LAMPORTS_PER_SOL),
                    formatted: (obj.account.data.parsed.info.stake.delegation.stake
                        / LAMPORTS_PER_SOL).toFixed(2) + " SOL"
                };
            }).filter((item) => item.amount > 0.01)
            activating.sort((a, b) => b.amount - a.amount);
            let totalActivating = activating.reduce((acc, cur) => acc + cur.amount, 0);

            let deactivating = deactivatingAccounts.map((obj) => {
                return {
                    amount: (obj.account.data.parsed.info.stake.delegation.stake
                        / LAMPORTS_PER_SOL),
                    formatted: (obj.account.data.parsed.info.stake.delegation.stake
                        / LAMPORTS_PER_SOL).toFixed(2) + " SOL"
                };
            }).filter((item) => item.amount > 0.01)
            deactivating.sort((a, b) => b.amount - a.amount);
            let totalDeactivating = deactivating.reduce((acc, cur) => acc + cur.amount, 0);

            let message = "";
            if (activating.length > 0) {
                const formattedActivating = activating.length > 50 ? "" : "Activating:\n" + activating.map(entry => `- ${entry.formatted}`).join("\n");
                message += formattedActivating + "\nTotal Activating: " + totalActivating.toFixed(2) + " SOL\n\n";
            }
            if (deactivating.length > 0) {
                const formattedDeactivating = deactivating.length > 50 ? "" :"Deactivating:\n" + deactivating.map(entry => `- ${entry.formatted}`).join("\n");
                message += formattedDeactivating + "\nTotal Deactivating: " + totalDeactivating.toFixed(2) + " SOL\n\n";
            }

            message += "Net Changes: " + (totalActivating-totalDeactivating).toFixed(2) + " SOL"

            if (message.trim() !== "") {
                bot.sendMessage(chatId, message).then((sentMessage) => {
                    const messageId = sentMessage.message_id;
                    setTimeout(() => {
                        bot.deleteMessage(chatId, messageId);
                    }, autoDeleteTimer);
                });
            } else {
                bot.sendMessage(chatId, "No stake data available.").then((sentMessage) => {
                    const messageId = sentMessage.message_id;
                    setTimeout(() => {
                        bot.deleteMessage(chatId, messageId);
                    }, autoDeleteTimer);
                });
            }
        } catch (e) {
            console.log(e);
            bot.sendMessage(chatId, "Error: the action couldn't be processed!").then((sentMessage) => {
                const messageId = sentMessage.message_id;
                setTimeout(() => {
                    bot.deleteMessage(chatId, messageId);
                }, autoDeleteTimer);
            });
        }
    }
});

function formatSeconds(seconds) {
    var days = Math.floor(seconds / (3600 * 24));
    var hours = Math.floor((seconds % (3600 * 24)) / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secondsLeft = seconds % 60;

    var result = "";
    if (days > 0) {
        result += days + "d ";
    }
    if (hours > 0) {
        result += hours + "h ";
    }
    if (minutes > 0) {
        result += minutes + "m ";
    }
    if (secondsLeft > 0) {
        result += secondsLeft + "s";
    }

    return result.trim();
}

function findSmallestGreaterThanX(array, x) {
    // Filter the array to get only numbers greater than X
    const filteredArray = array.filter(num => num > x);

    // If there are no numbers greater than X, return null
    if (filteredArray.length === 0) {
        return null;
    }

    // Find the smallest number greater than X
    return Math.min(...filteredArray);
}
