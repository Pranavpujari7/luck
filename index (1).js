(function (exports) {
  "use strict";

  // ---------- settings (edit these) ----------
  const APP_NAME = "lucky 3";             // fallback name match (only used if APP_ID is empty)
  const APP_ID = "1554103574085238834";    // bot application id (Lucky 3, the cat avatar one)
  const COMMAND_NAME = "Decode";          // the message command name
  const HIDE_SHEET = true;                // close the long-press menu on puzzle messages
  const MODE = "both";                    // "double" = double-tap, "hold" = long-press, "both"
  const DEBUG = true;                     // show one status dialog a few seconds after Discord starts
  const CMD_ID = "";                      // optional manual override (only if auto-lookup fails)
  const CMD_VERSION = "";                 // optional manual override (usually same as id)
  // --------------------------------------------

  const { findByProps, findByStoreName } = vendetta.metro;
  const { before, instead } = vendetta.patcher;
  const alerts = vendetta.ui.alerts;
  let lastAlert = 0;
  function say(msg) { try { console.log("[QuickDecode] " + msg); } catch (e) {} }
  function alertMsg(msg) {
    say(msg);
    const now = Date.now();
    if (now - lastAlert < 15000) return;
    lastAlert = now;
    setTimeout(function () {
      try { alerts.showConfirmationAlert({ title: "Quick Decode", content: msg, confirmText: "OK" }); } catch (e) {}
    }, 400);
  }

  const ActionSheet = findByProps("openLazy", "hideActionSheet");
  const RestAPI = findByProps("getAPIBaseURL", "get");
  const SessionStore = findByProps("getSessionId");
  const Snowflake = findByProps("fromTimestamp");
  const ChannelStore = findByStoreName("ChannelStore");
  const MessageStore = findByStoreName("MessageStore");
  const ReactionActions = findByProps("addReaction", "removeReaction");
  const PermissionStore = findByStoreName("PermissionStore");
  const PermConsts = (vendetta.metro.common.constants && vendetta.metro.common.constants.Permissions) ||
    (findByProps("Permissions") || {}).Permissions || {};
  const ADD_REACT = PermConsts.ADD_REACTIONS;

  const unpatches = [];
  const lastFired = {};
  let cmdCache = null;
  let knownBotId = APP_ID || "";

  function nonce() {
    try { return String(Snowflake.fromTimestamp(Date.now())); }
    catch (e) { return String(Date.now() - 1420070400000) + String(Math.floor(Math.random() * 1e7)); }
  }

  // is this message from the target bot?
  function fromTarget(author) {
    if (!author || !author.bot) return false;
    if (knownBotId) return author.id === knownBotId;
    const n = ((author.globalName || "") + " " + (author.username || "")).toLowerCase();
    return n.indexOf(APP_NAME) !== -1;
  }

  function isPuzzle(message) {
    if (!message || !fromTarget(message.author)) return false;
    return ((message.embeds || []).length > 0) ||
           ((message.attachments || []).length > 0) ||
           ((message.components || []).length > 0);
  }

  function describe(e) {
    const status = e && e.status;
    const msg = (e && e.body && e.body.message) || (e && e.message) || "";
    return (status ? status + " " : "") + msg;
  }

  async function getCommand(channelId, guildId) {
    if (CMD_ID) {
      return { id: CMD_ID, version: CMD_VERSION || CMD_ID, name: COMMAND_NAME, type: 3, application_id: knownBotId };
    }
    if (cmdCache) return cmdCache;
    const urls = ["/channels/" + channelId + "/application-command-index"];
    if (guildId) urls.push("/guilds/" + guildId + "/application-command-index");
    urls.push("/users/@me/application-command-index");
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await RestAPI.get({ url: urls[i] });
        const body = res.body || {};
        const list = body.application_commands || [];
        const apps = body.applications || [];
        // work out which application ids match
        let ids = [];
        if (APP_ID) ids = [APP_ID];
        else ids = apps.filter(function (a) {
          return a && a.name && a.name.toLowerCase().indexOf(APP_NAME) !== -1;
        }).map(function (a) { return a.id; });
        const found = list.find(function (c) {
          return c.name === COMMAND_NAME && c.type === 3 && ids.indexOf(c.application_id) !== -1;
        });
        if (found) {
          cmdCache = found;
          knownBotId = found.application_id;
          return found;
        }
      } catch (e) { lastErr = e; }
    }
    const err = new Error(lastErr ? describe(lastErr) : "Decode of '" + APP_NAME + "' not in command list");
    err.step = "find";
    throw err;
  }

  async function runDecode(message) {
    const channelId = message.channel_id;
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel && channel.guild_id;
    let step = "find";
    try {
      const cmd = await getCommand(channelId, guildId);
      step = "send";
      const body = {
        type: 2,
        application_id: cmd.application_id,
        channel_id: channelId,
        session_id: SessionStore.getSessionId(),
        nonce: nonce(),
        data: {
          version: cmd.version,
          id: cmd.id,
          name: cmd.name,
          type: 3,
          target_id: message.id,
          application_command: cmd,
        },
        analytics_location: "context_menu",
      };
      if (guildId) body.guild_id = guildId;
      await RestAPI.post({ url: "/interactions", body: body });
    } catch (e) {
      cmdCache = null;
      alertMsg("Quick Decode " + (e && e.step || step) + " failed: " + describe(e));
    }
  }

  function fire(message) {
    const now = Date.now();
    if (lastFired[message.id] && now - lastFired[message.id] < 3000) return;
    lastFired[message.id] = now;
    say("decoding...");
    runDecode(message);
  }

  // channels with reactions off: pretend reactions are allowed (client-side only) where a puzzle is showing
  const spoofCache = {};
  function channelHasPuzzle(channelId) {
    const now = Date.now();
    const c = spoofCache[channelId];
    if (c && now - c.t < 8000) return c.v;
    let v = false;
    try {
      const msgs = MessageStore.getMessages(channelId);
      const arr = (msgs && (msgs.toArray ? msgs.toArray() : msgs._array)) || [];
      v = arr.slice(-40).some(isPuzzle);
    } catch (e) {}
    spoofCache[channelId] = { t: now, v: v };
    return v;
  }
  let spoofOK = false;
  if ((MODE === "double" || MODE === "both") && PermissionStore && PermissionStore.can && ADD_REACT !== undefined) {
    try {
      unpatches.push(instead("can", PermissionStore, function (args, orig) {
        const res = orig.apply(this, args);
        if (res) return res;
        try {
          if (args[0] === ADD_REACT && args[1] && args[1].id && channelHasPuzzle(args[1].id)) return true;
        } catch (e) {}
        return res;
      }));
      spoofOK = true;
    } catch (e) {}
  }

  // double-tap = Discord adds a reaction; we catch it
  let hookA = false, hookB = false;
  const REACT_URL = /\/channels\/(\d+)\/messages\/(\d+)\/reactions\//;
  if (MODE === "double" || MODE === "both") {
    if (ReactionActions && MessageStore) {
      try {
        unpatches.push(instead("addReaction", ReactionActions, function (args, orig) {
          try {
            const m = MessageStore.getMessage(args[0], args[1]) || MessageStore.getMessage(args[1], args[0]);
            if (m && isPuzzle(m)) { fire(m); return; }
          } catch (e) {}
          return orig.apply(this, args);
        }));
        hookA = true;
      } catch (e) {}
    }
    if (RestAPI && MessageStore && RestAPI.put) {
      try {
        unpatches.push(instead("put", RestAPI, function (args, orig) {
          try {
            const url = args[0] && args[0].url;
            const hit = typeof url === "string" && REACT_URL.exec(url);
            if (hit) {
              const m = MessageStore.getMessage(hit[1], hit[2]);
              if (m && isPuzzle(m)) {
                fire(m);
                return Promise.resolve({ ok: true, status: 204, body: {}, headers: {} });
              }
            }
          } catch (e) {}
          return orig.apply(this, args);
        }));
        hookB = true;
      } catch (e) {}
    }
    if (!hookA && !hookB) say("double-tap hook unavailable, using hold");
  }

  // hold (long-press)
  if ((MODE === "hold" || MODE === "both" || !(hookA || hookB)) && ActionSheet && RestAPI) {
    unpatches.push(before("openLazy", ActionSheet, function (args) {
      const key = args[1];
      if (key !== "MessageLongPressActionSheet") return;
      const message = args[2] && args[2].message;
      if (!isPuzzle(message)) return;
      fire(message);
      if (HIDE_SHEET) setTimeout(function () { try { ActionSheet.hideActionSheet(); } catch (e) {} }, 120);
    }));
  }

  const status = "Quick Decode (Lucky 3 cat) loaded (" + MODE + (MODE !== "hold" ? ", hooks: " + (hookA ? "A" : "-") + (hookB ? "B" : "-") + (spoofOK ? "P" : "-") : "") + ")";
  say(status);
  if (DEBUG) setTimeout(function () { alertMsg(status); }, 6000);

  exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
  return exports;
})({});
