const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const {Connection,PublicKey, LAMPORTS_PER_SOL} = require('@solana/web3.js');
require('dotenv').config();


const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});

const slotTimeAvgSeconds = 0.450
const autoDeleteTimer = 60_000

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, process.env.VALIDATOR_NAME ? `Welcome ${process.env.VALIDATOR_NAME} Operators` : "Welcome Operators", {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Stake Changes",
                        callback_data: "stakeChanges"
                    },
                    {
                        text: "Ranking",
                        callback_data: "ranking"
                    },
                    {
                        text: "Epoch Infos",
                        callback_data: "epochInfos"
                    },
                    {
                        text: "Rewards",
                        callback_data: "rewards"
                    }
                ]
            ]
        }
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const command = query.data;

    if (command === "rewards") {
        try {
            const connection = new Connection(process.env.RPC_URL)
            const leaderSchedule = await connection.getLeaderSchedule()
            const epochInfo = await connection.getEpochInfo()
            const leaderSlots = leaderSchedule[process.env.IDENTITY_ADDRESS] || []
            const baseSlot = epochInfo.absoluteSlot - epochInfo.slotIndex
            const rewards = await Promise.all(leaderSlots.filter((slotIndex) => slotIndex < epochInfo.slotIndex).map(async (slotIndex) => {
                const slot = baseSlot + slotIndex
                try {
                    const slotInfo = await connection.getBlock(slot, {
                        rewards: true,
                        maxSupportedTransactionVersion: 0,
                        transactionDetails: "none"
                    })
                    return {slot, rewards: (slotInfo?.rewards[0]?.lamports || 0) / 10 ** 9}
                } catch (e) {
                    return {slot, rewards: 0}
                }
            }))
            const totalRewards = rewards.reduce((curr, prev) => curr + prev.rewards, 0)
            const message = rewards.map(item => `${item.slot}: ${item.rewards.toFixed(4)} SOL`).join('\n').concat(`\n\nTotal: ${totalRewards.toFixed(4)} SOL`)
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
            });
            activating.sort((a, b) => b.amount - a.amount);
            let totalActivating = activating.reduce((acc, cur) => acc + cur.amount, 0);

            let deactivating = deactivatingAccounts.map((obj) => {
                return {
                    amount: (obj.account.data.parsed.info.stake.delegation.stake
                        / LAMPORTS_PER_SOL),
                    formatted: (obj.account.data.parsed.info.stake.delegation.stake
                        / LAMPORTS_PER_SOL).toFixed(2) + " SOL"
                };
            });
            deactivating.sort((a, b) => b.amount - a.amount);
            let totalDeactivating = deactivating.reduce((acc, cur) => acc + cur.amount, 0);

            let message = "";
            if (activating.length > 0) {
                const formattedActivating = "Activating:\n" + activating.map(entry => `- ${entry.formatted}`).join("\n");
                message += formattedActivating + "\nTotal Activating: " + totalActivating.toFixed(2) + " SOL\n\n";
            }
            if (deactivating.length > 0) {
                const formattedDeactivating = "Deactivating:\n" + deactivating.map(entry => `- ${entry.formatted}`).join("\n");
                message += formattedDeactivating + "\nTotal Deactivating: " + totalDeactivating.toFixed(2) + " SOL\n";
            }

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
