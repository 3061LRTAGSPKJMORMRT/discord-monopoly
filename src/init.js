const {MessageMentions: {USERS_PATTERN, CHANNELS_PATTERN}, TextChannel} = require("discord.js");
let config = require("./config.json");
const playGame = require("./game.js");
const {isEqual} = require("lodash");
const {resolve} = require("path");
const {writeFileSync} = require("fs");

class GameInstance {
	constructor(options) {
		let opts = refineOptions(options);
		let newPreset = Object.assign({}, config, opts);
		if (!isEqual(newPreset, config)) {
			updatePreset(opts);
		}
		return targetChannel;
	};
}

function updatePreset(opts) {
	let newPreset = Object.assign({}, config, opts);
	writeFileSync(resolve(__dirname, "config.json"), JSON.stringify(newPreset));
	delete require.cache[require.resolve("./config.json")];
};

function targetChannel(message) {
	if (!(message.channel instanceof TextChannel)) {
		throw new Error("Shadow is noob");
	} else if ((config.channel ? message.channel.id == config.channel : true) && config.owners.includes(message.author.id)) {
		playGame(message);
	}
};

function refineOptions(options) {
	if (!options) return {};
	options.prefix = options.prefix || "r!";
	options.owners = validateOwners(options.owners);
	options.channel = "channel" in options ? validateChannelID(options.channel) : null;
	options.bidDuration = validateNumber(options.bidDuration) || config.bidDuration;
	options.turnDuration = validateNumber(options.turnDuration) || config.turnDuration;
	return options;
};

function validateOwners(owners) {
	if (Array.isArray(owners)) {
		let validOwners = owners.filter(id => `<@${id}>`.match(USERS_PATTERN));
		if (!validOwners.length) {
			throw new Error("Not a single user ID designates a potentially valid owner.");
		} else {
			return validOwners;
		}
	} else if (!owners) {
		throw new Error("You should provide at least one owner to the bot (usually you).");
	} else if (typeof owners === "number" ||
		(typeof owners === "string" && +owners)) {
		if (`<@${owners}>`.match(USERS_PATTERN)) {
			return owners;
		} else {
			throw new Error(`"${owners}" is not a valid ID.`);
		}
	} else {
		throw Error(`Expected owners property to be either an array or a 18-digit number, received type ${typeof owners} instead.`);
	}
};

function validateChannelID(channel) {
	if ((!channel && channel !== 0) ||
		(["number", "string"].includes(typeof channel) && `<#${channel}>`.match(CHANNELS_PATTERN))
	) {
		return channel;
	} else {
		throw new Error(`Expected channel property to be a number and a valid ID, received type ${typeof channel} and value ${id} instead.
If you do not want to lock onto any precise channel, please omit the property entirely.`);
	}
};

function validateNumber(n) {
	if (n !== 0 && (!n || Number(n))) {
		return n;
	} else {
		throw new Error(`Expected value ${n} to be a number or a falsy value, received type ${typeof n} instead.`);
	}
};

module.exports = GameInstance;
