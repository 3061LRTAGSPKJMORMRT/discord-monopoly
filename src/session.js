const Board = require("./board.json");
const Callbacks = require("./collectorCallbacks.js");
const {Collection, MessageEmbed} = require("discord.js");
const Collectors = require("./collectors.js");
const Chance = require("./chance.js");
const Community = require("./community.js");
const {isEqual, flatten} = require("lodash");
const {bidDuration, turnDuration} = require("./config.json");
const getUser = require("./getUser.js");
const MessageHandler = require("./message.js");
const Player = require("./player.js");
const footerInstructions = `Type \`1\` to select Option 1, \`2\` to select Option 2, etc.. You only have ${turnDuration} seconds to decide.`;

class Session {
	constructor(channel) {
		this.channel = channel;
		this.players = new Collection();
		this.board = Board;
		this.messageHandler = new MessageHandler(this.channel);
		this.occupiedProperties = new Collection();
		this.turnListener = {};
		this.hotels = 12;
		this.houses = 32;
		this.hasChanceOutOfJail = true;
		this.hasCommunityOutOfJail = true;
		this.turnHandler = this.createTurnToggler();
		this.started = false;
	}

	*createTurnToggler() {
		let i = 0;
		while (true) {
			yield this.orderedPlayers[i];
			if (i + 1 === this.orderedPlayers.length) {
				i = 0;
			} else {
				i++;
			}
		}
	};
};

Session.prototype.addPlayer = function(message) {
	let user = getUser(message);
	if (user) {
		if (!this.players.has(user)) {
			this.players.set(user.id, new Player(user, this));
			return true;
		} else {
			return "already here";
		}
	}

	return false;
};

Session.prototype.clearPlayerList = function() {
	if (this.players.size) {
		this.players.clear();
		return true;
	}
	return false;
};

Session.prototype.executeTurn = function(player, fixedRoll) {
	let roll = fixedRoll || this.makeDiceRoll(player);
	if (player.isJailed) {
		this.handleJailedPlayer(player, this.channel, roll);
		return;
	} else {
		if (roll.doubles === 3) {
			player.jail({reason: "doubles"});
			return;
		}
		player.advance(roll.rollTotal);
		this.handleTileAction(player, roll);		
		return;
	}
};

Session.prototype.endGame = function(currentSessions) {
	if (this.started) {
		let text = this.players.array().sort(function(player1, player2) {
			return player2.cash - player1.cash;
		}).map((user, i) => {
			let {username, cash} = user;
			return `${i+1} - ${username} ($${cash})`;
		}).join("\n");
		this.turnListener.stop("ended game");
		this.channel.send(`Game over. Ranking of players (not including disqualified users):
${text}`);
	} else {
		this.channel.send("You've decided to abandon playing.");
	}
	currentSessions.splice(currentSessions.indexOf(this.channel.id), 1);
};

Session.prototype.handleBankruptcy = function(player, startingCount = 0) {
	let failedAnswers = startingCount;
	this.flushMessages().then(() => {
		manageBankruptPlayer(this, player, failedAnswers);
	});
};

Session.prototype.handleAuction = function(property) {
	this.stackMessage(`Auction time! For ${bidDuration}s, place your bids in order to buy ${property.name}.`);
	this.flushMessages().then(() => {
		let max = 0;
		let winner = {};
		let bidHandler = Collectors.handleAuction(this, this.channel);
		bidHandler.on("collect", msgg => {
			if (msgg.content > max) {
				winner = this.players.get(msgg.author.id);
				max = +msgg.content;
				this.sendMessage(`The leader is currently ${winner.username} with a $${max} offer.`);
			}
		});
		bidHandler.on("end", (collected) => {
			this.sendMessage("Time's up!").then(() => {
				if (collected.size) {
					winner.buy(property, max);
					this.flushMessages().then(() => {
						this.toggleTurns();
					});
				} else {
					this.sendMessage("No bid was made. Moving on.").then(() => {
						this.toggleTurns();
					});
				}
			});
		});
	});
};

Session.prototype.handleJailedPlayer = function(player, roll) {
	if (player.turnsInJail === 3) {
		player.free({reason: "3 turns"});
		let dice = this.throwDice();
		if (!dice.double) {
			player.pay(50);
			let fixedRoll = {
				rollTotal: dice.sum
			};
			this.executeTurn(player, fixedRoll);
		}
	} else {
		let leftTurns = 3 - player.turnsInJail;
		let options = [`Wait for ${leftTurns} turn(s).`];
		if (player.cash >= 50) {
			options.push("Pay $50 as a fine.");
		}
		if (player.canBeFreed) {
			let numberOfCards = Number(player.ownsFreedomChance) + Number(player.ownsFreedomCommunity);
			options.push(`Use a card out of ${numberOfCards} and free yourself.`);
		}
		let cap = options.length;
		let fields = options.map((option, i) => {
			return {
				name: `Option ${i+1}`,
				value: option,
				inline: true
			};
		});
		const Embed = createEmbed(fields);
		this.stackMessage(Embed);
		this.flushMessages().then(() => {
			const decisionMaker = Collectors.handleNumericalDecision(player, cap);
			decisionMaker.on("end", Callbacks.handleJailDecision(player, this));
		});
	}
};

Session.prototype.handleTileAction = function(player, roll) {
	if (player.position.name === "Go To Jail") {
		this.jailPlayer({reason: "tile"});
		return;
	}
	if (player.position.type === "tax") {
		this.handleTax(player);
		return;
	}
	if (["community-chest", "chance"].includes(player.position.type)) {
		this.handleSupriseCard(player, roll);
		return;
	}
	if (["railroad", "property"].includes(player.position.type)) {
		this.handleProperty(player, roll);
		return;
	}
	if(["go", "free-parking"].includes(player.position.type)) {
		this.flushMessages().then(() => {
			this.toggleTurns();
		});
	}
};

Session.prototype.handleTax = function(player) {
	this.stackMessage(`${player.username} landed on a Tax tile.`);
	player.pay(player.position.cost);
	this.flushMessages().then(() => {
		this.toggleTurns();
	});
};

Session.prototype.handleSupriseCard = function(player) {
	const card = player.position.type === "community-chest" ? Community(this)(player, this) : Chance(this)(player, this);
	if (card.message) {
		this.stackMessage(card.message);
	}
	card.effect(player, this);
	this.flushMessages().then(() => {
		if (player.cash >= 0) {
			this.toggleTurns();
		} else {
			this.handleBankruptcy(player);
		}
	});
};

Session.prototype.handleProperty = function(player, roll) {
	let property = player.position;
	if (this.occupiedProperties.has(property)) {
		let owner = this.occupiedProperties.get(property);
		if (isEqual(owner, player)) {
			this.stackMessage(`${owner.username} owns this property, so nothing happens.`);
			this.flushMessages().then(() => {
				this.toggleTurns();
			});
		} else {
			player.pay(property.rent[0]);
			owner.receive(property.rent[0]);
			if (player.cash < 0) {
				this.handleBankruptcy(player);
			} else {
				this.flushMessages().then(() => {
					this.toggleTurns();
				});
			}
		}
	} else {
		if (player.cash >= property.cost) {
			const embed = createEmbed([`Buy the property for $${property.cost}`, "Do nothing (will put the property for auction)"]);
			this.stackMessage(`Choose your action`, embed);
			this.flushMessages().then(() => {
				const decisionMaker = Collectors.handleNumericalDecision(player, this.channel, 2);
				decisionMaker.on("end", (collected, reason) => {
					if (reason === "time") {
						this.sendMessage("You took too much time to decide. The property will now be auctioned.").then(() => {
							this.handleAuction(property);
						});
					} else {
						let msg = collected.first();
						if (+msg.content === 1) {
							player.buy(property);
							this.flushMessages().then(() => {
								this.toggleTurns();
							});
						} else {
							this.handleAuction(property);
						}
					}
				});
			});
		} else {
			this.handleAuction(property);
		}
	}
};

Session.prototype.jailPlayer = function(player, reason) {
	player.jail(reason);
	this.flushMessages().then(() => {
		this.toggleTurns();
	});
};

Session.prototype.killPlayer = function(player) {
	this.players.delete(player.id);
	if (player.ownsFreedomChance) {
		this.hasChanceOutOfJail = true;
	}
	if (player.ownsFreedomCommunity) {
		this.hasCommunityOutOfJail = true;
	}
	for (let property of player.properties) {
		player.releaseProperty(property);
	}
	this.sendMessage(`${player.username} has lost.`);
	player = {}; // bye bye
};

Session.prototype.listPlayers = function() {
	let players = this.players.array().map(name => `\`${name}\``).join(", ");
	return `Currently registered players: ${players}`;
};

Session.prototype.makeDiceRoll = function(player, iterations) {
	let roll = {};
	let doubleCount = 0;
	let rollTotal = 0;
	if (iterations) {
		for (let i = 0; i < iterations; i++) {
			roll = this.throwDice();
			this.stackMessage(`${player.username} rolled ${roll.sum} (${roll.dice1}, ${roll.dice2}).`);
			rollTotal += roll.sum;
			if (roll.double) {
				doubleCount++;
			}
		}
	} else {
		while (doubleCount < 3) {
			roll = this.throwDice();
			this.stackMessage(`${player.username} rolled ${roll.sum} (${roll.dice1}, ${roll.dice2}).`);
			rollTotal += roll.sum;
			if (roll.double) {
				doubleCount++;
			}
			if (!roll.double) {
				break;
			}
		}
	}
	return {
		rollTotal,
		doubleCount
	};
};

Session.prototype.manageTurn = function(player) {
	this.messageHandler.send("turn", player.username, turnDuration).then((msg) => {
		this.turnListener = Collectors.handleTurn(player, msg.channel);
		this.turnListener.on("end", (message, reason) => {
			if (reason === "time") {
				this.messageHandler.send("timeout", player.username).then(() => {
					this.toggleTurns();
				});
			} else if (reason === "ended game") {
				return;
			} else {
				this.executeTurn(player);
			}
		});
	});
};

Session.prototype.removePlayer = function(message) {
	let player = getUser(message);
	if (player) {
		if (this.players.has(player.id)) {
			this.players.delete(player.id);
			return true;
		} else {
			return false;
		}
	}

	return null;
};

Session.prototype.stackMessage = function(...content) {
	this.messageHandler.stackCrudeMessage.apply(this.messageHandler, content);
};

Session.prototype.stackCardMessage = function(message) {
	this.messageHandler.stackCardMessage(message);
};

Session.prototype.flushMessages = function() {
	return this.messageHandler.flushMessages();
};

Session.prototype.setTakenProperty = function(property, owner) {
	this.occupiedProperties.set(property, owner);
};

Session.prototype.sendMessage = function(...content) {
	return this.channel.send.apply(this.channel, content);
};

Session.prototype.startGame = function() {
	this.started = true;
	this.orderedPlayers = randomize(this.players.keyArray());
	this.toggleTurns();
};

Session.prototype.throwDice = function() {
	let dice1 = Math.floor(Math.random() * 5) + 1;
	let dice2 = Math.floor(Math.random() * 5) + 1;
	return {
		sum: dice1 + dice2,
		double: dice1 === dice2,
		dice1,
		dice2
	};
};

Session.prototype.toggleTurns = function() {
	let user = this.turnHandler.next().value;
	let player = this.players.get(user.id);
	this.manageTurn(player);
};

function createEmbed(array) {
	const fields = prepareFields(array);
	return new MessageEmbed({
		color: 0x366B13,
		fields,
		footer: {
			text: footerInstructions
		}
	});
};

function prepareFields(array) {
	return array.map((field, i) => {
		return {
			name: `Option ${i+1}`,
			value: field,
			inline: true
		};
	});
};


function randomize(array) {
	let n = Math.floor(Math.random() * array.length);
	let [item] = array.splice(n, 1);
	array.push(item);
	return array;
}

function format(str) {
	return capitalize(str.replace("-", ""));
};

function capitalize(str) {
	return str.replace(/\W*./g, match => match.toUpperCase());
};

function manageBankruptPlayer(session, player, failedAnswers) {
	let failedAnswers = 0;
	let allOwnedTiles = session.occupiedProperties.keyArray().filter(property => isEqual(property.owner, player));
	session.stackMessage(`${player.username}'s balance is -$${Math.abs(player.cash)}.`);

	if (allOwnedTiles.length) {
		const fields = allOwnedTiles.map(tile => `Sell ${tile.name} for $${tile.cost/2}.`).slice(0, 23).push("Forfeit.");
			// discord only allows for max. 25 fields to show up, but it only serves for buy-happy people
			const totalCollected = allOwnedTiles.map(tile => tile.cost/2).reduce((a, b) => a+b);
			if (totalCollected >= Math.abs(player.cash)) {
				const length = fields.length;
				const embed = createEmbed(fields);
				session.sendMessage(`Choose which property you will sell. You need $${Math.abs(player.cash)} to stay in the game.`, embed)
				.then(() => {
					const decisionMaker = Collectors.handleNumericalDecision(player, this.channel, length);
					decisionMaker.on("end", decideBehavior(session, failedAnswers, player));
				});
			} else {
				session.sendMessage(`Even if ${player.username} sold all the properties they own, they will still have a negative balance.
${player.username} has lost.`);
				session.killPlayer(player);
			}
	} else {
		session.killPlayer(player);
	}
};

function decideBehavior(session, failedAnswers, player) {
	return function(collected, reason) {
		let message = collected.first();
		if (reason === "time") {
			session.sendMessage(`You didn't provide any answer in time for attempt ${failedAnswers+1}/3.`);
			failedAnswers++;
			if (failedAnswers === 3) {
				session.sendMessage(`${turnDuration * 3} seconds have passed without any action from the player.`);
				session.killPlayer(player);
			} else {
				session.handleBankruptcy(player, failedAnswers);
			}
		} else {
			failedAnswers = 0;
			let choiceIndex = +message.content;
			if (choiceIndex === fields.length) {
				session.sendMessage(`You chose to forfeit.`);
				session.killPlayer(player);
			} else {
				let aimedTile = fullOwnedTiles[choiceIndex];
				player.releaseProperty(aimedTile, true);
				session.flushMessages().then(() => {
					if (player.cash < 0) {
						session.handleBankruptcy(player);
					} else {
						session.toggleTurns();
					}
				});
			}
		}
	};
};

module.exports = Session;
