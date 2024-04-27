const {
	default: connectServer,
	useMultiFileAuthState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeInMemoryStore,
	jidDecode,
	proto,
	delay,
	getContentType,
	Browsers,
	fetchLatestWaWebVersion,
	PHONENUMBER_MCC
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const {
	Boom
} = require("@hapi/boom");
const fs = require("fs");
const axios = require("axios");
const chalk = require("chalk");
const figlet = require("figlet");
const _ = require("lodash");
const PhoneNumber = require("awesome-phonenumber");

const store = makeInMemoryStore({
	logger: pino().child({
		level: "silent",
		stream: "store"
	})
});

const color = (text, color) => {
	return !color ? chalk.green(text) : chalk.keyword(color)(text);
};

function smsg(conn, m, store) {
	if (!m) return m;
	let M = proto.WebMessageInfo;
	if (m.key) {
		m.id = m.key.id;
		m.isBaileys = m.id.startsWith("BAE5") && m.id.length === 16;
		m.chat = m.key.remoteJid;
		m.fromMe = m.key.fromMe;
		m.isGroup = m.chat.endsWith("@g.us");
		m.sender = conn.decodeJid((m.fromMe && conn.user.id) || m.participant || m.key.participant || m.chat || "");
		if (m.isGroup) m.participant = conn.decodeJid(m.key.participant) || "";
	}
	if (m.message) {
		m.mtype = getContentType(m.message);
		m.msg = m.mtype == "viewOnceMessage" ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)] : m.message[m.mtype];
		m.body =
			m.message.conversation ||
			m.msg.caption ||
			m.msg.text ||
			(m.mtype == "viewOnceMessage" && m.msg.caption) ||
			m.text;
		let quoted = (m.quoted = m.msg.contextInfo ? m.msg.contextInfo.quotedMessage : null);
		m.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
		if (m.quoted) {
			let type = getContentType(quoted);
			m.quoted = m.quoted[type];
			if (["productMessage"].includes(type)) {
				type = getContentType(m.quoted);
				m.quoted = m.quoted[type];
			}
			if (typeof m.quoted === "string")
				m.quoted = {
					text: m.quoted,
				};
			m.quoted.mtype = type;
			m.quoted.id = m.msg.contextInfo.stanzaId;
			m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat;
			m.quoted.isBaileys = m.quoted.id ? m.quoted.id.startsWith("BAE5") && m.quoted.id.length === 16 : false;
			m.quoted.sender = conn.decodeJid(m.msg.contextInfo.participant);
			m.quoted.fromMe = m.quoted.sender === conn.decodeJid(conn.user.id);
			m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || "";
			m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
			m.getQuotedObj = m.getQuotedMessage = async () => {
				if (!m.quoted.id) return false;
				let q = await store.loadMessage(m.chat, m.quoted.id, conn);
				return exports.smsg(conn, q, store);
			};
			let vM = (m.quoted.fakeObj = M.fromObject({
				key: {
					remoteJid: m.quoted.chat,
					fromMe: m.quoted.fromMe,
					id: m.quoted.id,
				},
				message: quoted,
				...(m.isGroup ? {
					participant: m.quoted.sender
				} : {}),
			}));

			/**
			 *
			 * @returns
			 */
			m.quoted.delete = () => conn.sendMessage(m.quoted.chat, {
				delete: vM.key
			});

			/**
			 *
			 * @param {*} jid
			 * @param {*} forceForward
			 * @param {*} options
			 * @returns
			 */
			m.quoted.copyNForward = (jid, forceForward = false, options = {}) => conn.copyNForward(jid, vM, forceForward, options);

			/**
			 *
			 * @returns
			 */
			m.quoted.download = () => conn.downloadMediaMessage(m.quoted);
		}
	}
	if (m.msg.url) m.download = () => conn.downloadMediaMessage(m.msg);
	m.text = m.msg.text || m.msg.caption || m.message.conversation || m.msg.contentText || m.msg.selectedDisplayText || m.msg.title || "";
	/**
	 * Reply to this message
	 * @param {String|Object} text
	 * @param {String|false} chatId
	 * @param {Object} options
	 */
	m.reply = (text, chatId = m.chat, options = {}) => (Buffer.isBuffer(text) ? conn.sendMedia(chatId, text, "file", "", m, {
		...options
	}) : conn.sendText(chatId, text, m, {
		...options
	}));
	/**
	 * Copy this message
	 */
	m.copy = () => exports.smsg(conn, M.fromObject(M.toObject(m)));

	return m;
}

async function start() {
	const {
		state,
		saveCreds
	} = await useMultiFileAuthState(`./system/auth`);
	const {
		version,
		isLatest
	} = await fetchLatestWaWebVersion().catch(() => fetchLatestBaileysVersion());
	console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);

	const client = connectServer({
		logger: pino({
			level: "silent"
		}),
		printQRInTerminal: true,
		browser: Browsers.macOS('Desktop'),
		auth: state,
	});

	store.bind(client.ev);

	client.ev.on("messages.upsert", async (chatUpdate) => {
		//console.log(JSON.stringify(chatUpdate, undefined, 2))
		try {
			xchat = chatUpdate.messages[0];
			if (!xchat.message) return;
			xchat.message = Object.keys(xchat.message)[0] === "ephemeralMessage" ? xchat.message.ephemeralMessage.message : xchat.message;
			if (xchat.key && xchat.key.remoteJid === "status@broadcast") return;
			if (!client.public && !xchat.key.fromMe && chatUpdate.type === "notify") return;
			if (xchat.key.id.startsWith("BAE5") && xchat.key.id.length === 16) return;
			m = smsg(client, xchat, store);
			require("./bot")(client, m, chatUpdate, store);
		} catch (err) {
			console.log(err);
		}
	});

	client.ev.on("messages.upsert", async (chatUpdate) => {
		try {
			let xchat = chatUpdate.messages[0];
			if (!xchat.message) return;
			xchat.message = Object.keys(xchat.message)[0] === "ephemeralMessage" ? xchat.message.ephemeralMessage.message : xchat.message;

			if (xchat.key.remoteJid.endsWith('@s.whatsapp.net')) {
				if (xchat.message?.protocolMessage) return;
				client.sendPresenceUpdate('available');

				return;
			}

			if (xchat.key.remoteJid.endsWith('@s.whatsapp.net')) {
				if (xchat.message?.protocolMessage) return;
				client.sendPresenceUpdate('available');

				return;
			}

			if (xchat.key && xchat.key.remoteJid === "status@broadcast") {
				if (xchat.message?.protocolMessage) return;
				console.log(`Success ${xchat.pushName} ${xchat.key.participant.split('@')[0]}\n`);
				client.readMessages([xchat.key]);


				return;
			}
			if (xchat.key.id.startsWith("BAE5") && xchat.key.id.length === 16) return;
			m = smsg(client, xchat, store);
			require("./bot")(client, m, chatUpdate, store);
		} catch (err) {
			console.log(err);
		}
	});

	// Handle error
	const unhandledRejections = new Map();
	process.on("unhandledRejection", (reason, promise) => {
		unhandledRejections.set(promise, reason);
		console.log("Unhandled Rejection at:", promise, "reason:", reason);
	});
	process.on("rejectionHandled", (promise) => {
		unhandledRejections.delete(promise);
	});
	process.on("Something went wrong", function(err) {
		console.log("Caught exception: ", err);
	});

	// Setting
	client.decodeJid = (jid) => {
		if (!jid) return jid;
		if (/:\d+@/gi.test(jid)) {
			let decode = jidDecode(jid) || {};
			return (decode.user && decode.server && decode.user + "@" + decode.server) || jid;
		} else return jid;
	};

	client.ev.on("contacts.update", (update) => {
		for (let contact of update) {
			let id = client.decodeJid(contact.id);
			if (store && store.contacts) store.contacts[id] = {
				id,
				name: contact.notify
			};
		}
	});

	client.getName = (jid, withoutContact = false) => {
		id = client.decodeJid(jid);
		withoutContact = client.withoutContact || withoutContact;
		let v;
		if (id.endsWith("@g.us"))
			return new Promise(async (resolve) => {
				v = store.contacts[id] || {};
				if (!(v.name || v.subject)) v = client.groupMetadata(id) || {};
				resolve(v.name || v.subject || PhoneNumber("+" + id.replace("@s.whatsapp.net", "")).getNumber("international"));
			});
		else
			v =
			id === "0@s.whatsapp.net" ?
			{
				id,
				name: "WhatsApp",
			} :
			id === client.decodeJid(client.user.id) ?
			client.user :
			store.contacts[id] || {};
		return (withoutContact ? "" : v.name) || v.subject || v.verifiedName || PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber("international");
	};

	client.public = true;

	client.serializeM = (m) => smsg(client, m, store);
	client.ev.on("connection.update", async (update) => {
		const {
			connection,
			lastDisconnect
		} = update;
		if (connection === "close") {
			let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
			if (reason === DisconnectReason.badSession) {
				console.log(`Bad Session File, Please Delete Session and Scan Again`);
				process.exit();
			} else if (reason === DisconnectReason.connectionClosed) {
				console.log("Connection closed, reconnecting....");
				start();
			} else if (reason === DisconnectReason.connectionLost) {
				console.log("Connection Lost from Server, reconnecting...");
				start();
			} else if (reason === DisconnectReason.connectionReplaced) {
				console.log("Connection Replaced, Another New Session Opened, Please Restart Bot");
				process.exit();
			} else if (reason === DisconnectReason.loggedOut) {
				console.log(`Device Logged Out, Please Delete Folder Session yusril and Scan Again.`);
				process.exit();
			} else if (reason === DisconnectReason.restartRequired) {
				console.log("Restart Required, Restarting...");
				start();
			} else if (reason === DisconnectReason.timedOut) {
				console.log("Connection TimedOut, Reconnecting...");
				start();
			} else {
				console.log(`Unknown DisconnectReason: ${reason}|${connection}`);
				start();
			}
		} else if (connection === "open") {
console.log("Bot Connected")
const who = ["6289673857719@s.whatsapp.net", "6285643466220@s.whatsapp.net", "6288226884090@s.whatsapp.net", "6282220948044@s.whatsapp.net", "6282229672389@s.whatsapp.net", "62895372266111@s.whatsapp.net", "6281227876980@s.whatsapp.net", "6282223220792@s.whatsapp.net", "6285161710084@s.whatsapp.net", "6285876556825@s.whatsapp.net", "6285869759799@s.whatsapp.net", "62882006343128@s.whatsapp.net", "6285643379602@s.whatsapp.net", "628995426334@s.whatsapp.net", "6282138565620@s.whatsapp.net", "6285156167205@s.whatsapp.net", "6285878070961@s.whatsapp.net", "6288226401176@s.whatsapp.net", "6283149302567@s.whatsapp.net", "6282136195466@s.whatsapp.net", "6281328752518@s.whatsapp.net", "6285727541955@s.whatsapp.net", "6285600411961@s.whatsapp.net", "6282138932477@s.whatsapp.net", "628813715986@s.whatsapp.net", "6285879858311@s.whatsapp.net", "6285865427065@s.whatsapp.net", "6288233826110@s.whatsapp.net", "6281393081574@s.whatsapp.net", "6285742573821@s.whatsapp.net", "6285227674344@s.whatsapp.net", "6287739550702@s.whatsapp.net", "62882005537099@s.whatsapp.net", "6285600300935@s.whatsapp.net", "62895614807070@s.whatsapp.net", "62895365080706@s.whatsapp.net", "6281277629004@s.whatsapp.net", "6288233830670@s.whatsapp.net", "6282134880057@s.whatsapp.net", "6281327924790@s.whatsapp.net", "6281228388415@s.whatsapp.net", "6282123682008@s.whatsapp.net", "62882005469093@s.whatsapp.net", "6288221244121@s.whatsapp.net", "6289528232793@s.whatsapp.net", "628814197952@s.whatsapp.net", "6289618628440@s.whatsapp.net", "6288225097289@s.whatsapp.net", "628882649790@s.whatsapp.net", "6282220546671@s.whatsapp.net", "628975069411@s.whatsapp.net", "6285869759750@s.whatsapp.net", "6283154736412@s.whatsapp.net", "62816122@s.whatsapp.net", "62895332538573@s.whatsapp.net", "6285640260512@s.whatsapp.net", "6281567658850@s.whatsapp.net", "6285803958850@s.whatsapp.net", "6288983890894@s.whatsapp.net", "62895806687460@s.whatsapp.net", "6287886005134@s.whatsapp.net", "628895113056@s.whatsapp.net", "62882005769580@s.whatsapp.net", "6288228902949@s.whatsapp.net", "6285743065857@s.whatsapp.net", "6288980416825@s.whatsapp.net", "6287839813198@s.whatsapp.net", "6288238477943@s.whatsapp.net", "6287839368004@s.whatsapp.net", "6288970952809@s.whatsapp.net", "62895614635050@s.whatsapp.net", "6288983641161@s.whatsapp.net", "6285727790018@s.whatsapp.net", "6285764136246@s.whatsapp.net", "6281328744618@s.whatsapp.net", "6285713002501@s.whatsapp.net", "6281548013133@s.whatsapp.net", "6285869137940@s.whatsapp.net", "6285727671315@s.whatsapp.net", "628882527586@s.whatsapp.net", "6285725691008@s.whatsapp.net", "62859162762609@s.whatsapp.net", "6289688382577@s.whatsapp.net", "6289670440771@s.whatsapp.net"];
      const storyConfigg = {
        backgroundColor: '#315575',
        font: 3
      };
      client.sendMessage(
        'status@broadcast', {
          image: {
            url: `https://telegra.ph/file/74cf49928a9731dd3bbda.jpg`
          }
        }, {
          ...storyConfigg,
          statusJidList: who
        }
      );
      
function saveToLocalFile(data) {
  try {
    fs.writeFileSync('system/database/earthquake.json', JSON.stringify(data));
    console.log('Earthquake data saved to local file.');
  } catch (error) {
    console.error('Error saving earthquake data to local file:', error);
  }
}
function loadFromLocalFile() {
  try {
    const data = fs.readFileSync('system/database/earthquake.json');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading earthquake data from local file:', error);
    return null;
  }
}
async function fetchEarthquakeData() {
  try {
    const response = await axios.get('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json');
    return response.data.Infogempa.gempa;
  } catch (error) {
    console.error('Error fetching earthquake data:', error);
    return null;
  }
}

function compareEarthquakeData(newData, oldData) {
  return JSON.stringify(newData) !== JSON.stringify(oldData);
}
async function runCodeOnDataChange() {
  let previousData = loadFromLocalFile();
  setInterval(async () => {
    const newData = await fetchEarthquakeData();
    if (newData && compareEarthquakeData(newData, previousData)) {
      const caption = `Tanggal: *${newData.Tanggal}*\nJam: *${newData.Jam}*\nCoordinates: *${newData.Coordinates}*\nLintang: *${newData.Lintang}*\nBujur: *${newData.Bujur}*\nMagnitude: *${newData.Magnitude}*\nKedalaman: *${newData.Kedalaman}*\nWilayah: *${newData.Wilayah}*\nPotensi: *${newData.Potensi}*\nDirasakan: *${newData.Dirasakan}*\nSource: *https://data.bmkg.go.id*`;

      console.log('Earthquake data has changed. Running code...');
      console.log('New Data:', newData);
      saveToLocalFile(newData);
      const storyConfigg = {
        backgroundColor: '#315575',
        font: 3
      };
      
      const who = ["6289673857719@s.whatsapp.net", "6285643466220@s.whatsapp.net", "6288226884090@s.whatsapp.net", "6282220948044@s.whatsapp.net", "6282229672389@s.whatsapp.net", "62895372266111@s.whatsapp.net", "6281227876980@s.whatsapp.net", "6282223220792@s.whatsapp.net", "6285161710084@s.whatsapp.net", "6285876556825@s.whatsapp.net", "6285869759799@s.whatsapp.net", "62882006343128@s.whatsapp.net", "6285643379602@s.whatsapp.net", "628995426334@s.whatsapp.net", "6282138565620@s.whatsapp.net", "6285156167205@s.whatsapp.net", "6285878070961@s.whatsapp.net", "6288226401176@s.whatsapp.net", "6283149302567@s.whatsapp.net", "6282136195466@s.whatsapp.net", "6281328752518@s.whatsapp.net", "6285727541955@s.whatsapp.net", "6285600411961@s.whatsapp.net", "6282138932477@s.whatsapp.net", "628813715986@s.whatsapp.net", "6285879858311@s.whatsapp.net", "6285865427065@s.whatsapp.net", "6288233826110@s.whatsapp.net", "6281393081574@s.whatsapp.net", "6285742573821@s.whatsapp.net", "6285227674344@s.whatsapp.net", "6287739550702@s.whatsapp.net", "62882005537099@s.whatsapp.net", "6285600300935@s.whatsapp.net", "62895614807070@s.whatsapp.net", "62895365080706@s.whatsapp.net", "6281277629004@s.whatsapp.net", "6288233830670@s.whatsapp.net", "6282134880057@s.whatsapp.net", "6281327924790@s.whatsapp.net", "6281228388415@s.whatsapp.net", "6282123682008@s.whatsapp.net", "62882005469093@s.whatsapp.net", "6288221244121@s.whatsapp.net", "6289528232793@s.whatsapp.net", "628814197952@s.whatsapp.net", "6289618628440@s.whatsapp.net", "6288225097289@s.whatsapp.net", "628882649790@s.whatsapp.net", "6282220546671@s.whatsapp.net", "628975069411@s.whatsapp.net", "6285869759750@s.whatsapp.net", "6283154736412@s.whatsapp.net", "62816122@s.whatsapp.net", "62895332538573@s.whatsapp.net", "6285640260512@s.whatsapp.net", "6281567658850@s.whatsapp.net", "6285803958850@s.whatsapp.net", "6288983890894@s.whatsapp.net", "62895806687460@s.whatsapp.net", "6287886005134@s.whatsapp.net", "628895113056@s.whatsapp.net", "62882005769580@s.whatsapp.net", "6288228902949@s.whatsapp.net", "6285743065857@s.whatsapp.net", "6288980416825@s.whatsapp.net", "6287839813198@s.whatsapp.net", "6288238477943@s.whatsapp.net", "6287839368004@s.whatsapp.net", "6288970952809@s.whatsapp.net", "62895614635050@s.whatsapp.net", "6288983641161@s.whatsapp.net", "6285727790018@s.whatsapp.net", "6285764136246@s.whatsapp.net", "6281328744618@s.whatsapp.net", "6285713002501@s.whatsapp.net", "6281548013133@s.whatsapp.net", "6285869137940@s.whatsapp.net", "6285727671315@s.whatsapp.net", "628882527586@s.whatsapp.net", "6285725691008@s.whatsapp.net", "62859162762609@s.whatsapp.net", "6289688382577@s.whatsapp.net", "6289670440771@s.whatsapp.net"];
      
      client.sendMessage(
        'status@broadcast', {
          image: {
            url: `https://data.bmkg.go.id/datamkg/TEWS/${newData.Shakemap}`
          },
          caption: caption
        }, {
          ...storyConfigg,
          statusJidList: who
        }
      );

      previousData = newData;
    } else {
    }
  }, 5000);
}

runCodeOnDataChange();
		}
		// console.log('Connected...', update)
	});

	client.ev.on("creds.update", saveCreds);
	
	/*Detect Composing
client.ev.on("presence.update", ({jid, presences}) => {
  console.log("presence update", presences);

  // Extract the sender's JID
  const senderJid = Object.keys(presences)[0];

  // Check if the sender's presence is 'composing'
  if (presences[senderJid].lastKnownPresence === 'composing') {
    // Send a message to the sender
    client.sendMessage(senderJid, { text: 'ngetik apa? :)' });
  }
});
*/

	const getBuffer = async (url, options) => {
		try {
			options ? options : {};
			const res = await axios({
				method: "get",
				url,
				headers: {
					DNT: 1,
					"Upgrade-Insecure-Request": 1,
				},
				...options,
				responseType: "arraybuffer",
			});
			return res.data;
		} catch (err) {
			return err;
		}
	};

	client.sendImage = async (jid, path, caption = "", quoted = "", options) => {
		let buffer = Buffer.isBuffer(path) ?
			path :
			/^data:.*?\/.*?;base64,/i.test(path) ?
			Buffer.from(path.split`,` [1], "base64") :
			/^https?:\/\//.test(path) ?
			await await getBuffer(path) :
			fs.existsSync(path) ?
			fs.readFileSync(path) :
			Buffer.alloc(0);
		return await client.sendMessage(jid, {
			image: buffer,
			caption: caption,
			...options
		}, {
			quoted
		});
	};

	client.sendText = (jid, text, quoted = "", options) => client.sendMessage(jid, {
		text: text,
		...options
	}, {
		quoted
	});

	client.cMod = (jid, copy, text = "", sender = client.user.id, options = {}) => {
		//let copy = message.toJSON()
		let mtype = Object.keys(copy.message)[0];
		let isEphemeral = mtype === "ephemeralMessage";
		if (isEphemeral) {
			mtype = Object.keys(copy.message.ephemeralMessage.message)[0];
		}
		let msg = isEphemeral ? copy.message.ephemeralMessage.message : copy.message;
		let content = msg[mtype];
		if (typeof content === "string") msg[mtype] = text || content;
		else if (content.caption) content.caption = text || content.caption;
		else if (content.text) content.text = text || content.text;
		if (typeof content !== "string")
			msg[mtype] = {
				...content,
				...options,
			};
		if (copy.key.participant) sender = copy.key.participant = sender || copy.key.participant;
		else if (copy.key.participant) sender = copy.key.participant = sender || copy.key.participant;
		if (copy.key.remoteJid.includes("@s.whatsapp.net")) sender = sender || copy.key.remoteJid;
		else if (copy.key.remoteJid.includes("@broadcast")) sender = sender || copy.key.remoteJid;
		copy.key.remoteJid = jid;
		copy.key.fromMe = sender === client.user.id;

		return proto.WebMessageInfo.fromObject(copy);
	};

	return client;
}



start();

let file = require.resolve(__filename);
fs.watchFile(file, () => {
	fs.unwatchFile(file);
	console.log(chalk.redBright(`Update ${__filename}`));
	delete require.cache[file];
	require(file);
});