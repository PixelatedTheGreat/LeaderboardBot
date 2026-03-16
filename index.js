const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActivityType,
} = require("discord.js");
const express = require("express");

// ── Config ──

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const API_SECRET = process.env.API_SECRET;
const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY;
const PORT = process.env.PORT || 3000;

const TOP10_ROLE_ID = process.env.TOP10_ROLE_ID;
const TOP50_ROLE_ID = process.env.TOP50_ROLE_ID;
const TOP100_ROLE_ID = process.env.TOP100_ROLE_ID;

// ── Discord Client ──

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ── Data Stores ──

// Leaderboard tracking: { "Currency": { discordId: rank }, ... }
const leaderboardData = {};

// Player stats: { robloxUserId: { username, currency, rebirths, crates, playtime, ... } }
const playerStats = new Map();

// Bloxlink cache: robloxUserId → [discordIds]
const robloxToDiscordCache = new Map();

// Reverse cache: discordId → robloxUserId
const discordToRobloxCache = new Map();

// ── Slash Command Registration ──

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Look up a player's in-game stats")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Discord user to look up (defaults to yourself)")
          .setRequired(false)
      ),
  ];

  const rest = new REST().setToken(DISCORD_TOKEN);

  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("[Commands] Registered /stats command");
  } catch (err) {
    console.error("[Commands] Failed to register commands:", err.message);
  }
}

// ── Bot Ready ──

client.once("ready", async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  await registerCommands();
  startServer();
  updateStatus();
});

async function updateStatus() {
  try {
   const res = await fetch("https://games.roproxy.com/v1/games?universeIds=134514210493315");
    const data = await res.json();
    const playerCount = data.data?.[0]?.playing || 0;

    client.user.setActivity(`${playerCount} players on YouTube Clicker`, {
      type: ActivityType.Custom,
    });
  } catch (err) {
    console.error("[Status] Failed to fetch player count:", err.message);
  }
}

setInterval(updateStatus, 60_000);

// ── Slash Command Handler ──

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "stats") {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const discordId = targetUser.id;

    // Find their Roblox ID
    const robloxId = discordToRobloxCache.get(discordId);

    if (!robloxId || !playerStats.has(String(robloxId))) {
      return interaction.reply({
        content: `No stats found for <@${discordId}>. They need to have joined the game recently.`,
        ephemeral: true,
      });
    }

    const stats = playerStats.get(String(robloxId));

    // Find their best leaderboard rank
    let bestRank = null;
    let bestBoard = null;
    for (const [board, ranks] of Object.entries(leaderboardData)) {
      if (ranks[discordId] !== undefined) {
        if (bestRank === null || ranks[discordId] < bestRank) {
          bestRank = ranks[discordId];
          bestBoard = board;
        }
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`${stats.username}'s Stats`)
      .setColor(0x5865f2)
      .setThumbnail(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`
      )
      .setTimestamp();

    // Add stat fields — adjust these to match what your game sends
    if (stats.currency !== undefined)
      embed.addFields({
        name: "Currency",
        value: formatNumber(stats.currency),
        inline: true,
      });
    if (stats.rebirths !== undefined)
      embed.addFields({
        name: "Rebirths",
        value: formatNumber(stats.rebirths),
        inline: true,
      });
    if (stats.crates !== undefined)
      embed.addFields({
        name: "Crates",
        value: formatNumber(stats.crates),
        inline: true,
      });
    if (stats.playtime !== undefined)
      embed.addFields({
        name: "Playtime",
        value: String(stats.playtime),
        inline: true,
      });

    if (bestRank) {
      embed.addFields({
        name: "Best Rank",
        value: `#${bestRank} on ${bestBoard}`,
        inline: true,
      });
    }

    return interaction.reply({ embeds: [embed] });
  }
});

// ── Helpers ──

function formatNumber(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return String(num);
}

function formatPlaytime(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ── Bloxlink API (with cache) ──

async function getDiscordIdsFromRoblox(robloxUserId) {
  const cached = robloxToDiscordCache.get(String(robloxUserId));
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://api.blox.link/v4/public/guilds/${GUILD_ID}/roblox-to-discord/${robloxUserId}`,
      { headers: { Authorization: BLOXLINK_API_KEY } }
    );

    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      console.error(
        `[Bloxlink] Non-JSON response for user ${robloxUserId} (status ${res.status})`
      );
      return [];
    }

    const data = await res.json();
    const ids =
      data.discordIDs && Array.isArray(data.discordIDs) ? data.discordIDs : [];

    // Cache both directions
    robloxToDiscordCache.set(String(robloxUserId), ids);
    for (const discordId of ids) {
      discordToRobloxCache.set(discordId, robloxUserId);
    }

    return ids;
  } catch (err) {
    console.error(
      `[Bloxlink] Failed to look up Roblox user ${robloxUserId}:`,
      err.message
    );
    return [];
  }
}

// ── Role Logic ──

function getRolesForRank(rank) {
  const roles = [];
  if (rank <= 10) roles.push(TOP10_ROLE_ID, TOP50_ROLE_ID, TOP100_ROLE_ID);
  else if (rank <= 50) roles.push(TOP50_ROLE_ID, TOP100_ROLE_ID);
  else if (rank <= 100) roles.push(TOP100_ROLE_ID);
  return roles;
}

const ALL_TIER_ROLES = () => [TOP10_ROLE_ID, TOP50_ROLE_ID, TOP100_ROLE_ID];

function getBestRank(discordId) {
  let best = Infinity;
  for (const ranks of Object.values(leaderboardData)) {
    if (ranks[discordId] !== undefined && ranks[discordId] < best) {
      best = ranks[discordId];
    }
  }
  return best === Infinity ? null : best;
}

async function syncAllRoles() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error(`[Roles] Guild ${GUILD_ID} not found`);
    return;
  }

  const allDiscordIds = new Set();
  for (const ranks of Object.values(leaderboardData)) {
    for (const discordId of Object.keys(ranks)) {
      allDiscordIds.add(discordId);
    }
  }

  for (const discordId of allDiscordIds) {
    const bestRank = getBestRank(discordId);
    const shouldHave = bestRank ? getRolesForRank(bestRank) : [];
    const shouldNotHave = ALL_TIER_ROLES().filter(
      (r) => !shouldHave.includes(r)
    );

    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) continue;

      for (const roleId of shouldHave) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId);
          console.log(
            `[Roles] Added role to ${member.user.tag} (rank #${bestRank})`
          );
        }
      }

      for (const roleId of shouldNotHave) {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId);
          console.log(
            `[Roles] Removed role from ${member.user.tag} (rank #${bestRank || "none"})`
          );
        }
      }
    } catch (err) {
      console.error(
        `[Roles] Failed to update roles for ${discordId}:`,
        err.message
      );
    }
  }
}

// ── Express API ──

function startServer() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/", (req, res) => {
    res.json({ status: "ok", bot: client.user.tag });
  });

  // Receives leaderboard data from Roblox
  app.post("/api/leaderboard", async (req, res) => {
    if (req.headers.authorization !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { leaderboard, players } = req.body;

    if (!leaderboard || !Array.isArray(players)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    console.log(
      `[API] Received ${players.length} players for leaderboard: ${leaderboard}`
    );

    const rankMap = {};
    let apiCalls = 0;

    for (const player of players) {
      const wasCached = robloxToDiscordCache.has(String(player.userId));
      const discordIds = await getDiscordIdsFromRoblox(player.userId);

      if (!wasCached) apiCalls++;

      for (const id of discordIds) {
        if (rankMap[id] === undefined || player.rank < rankMap[id]) {
          rankMap[id] = player.rank;
        }
      }

      if (!wasCached) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    leaderboardData[leaderboard] = rankMap;

    const resolvedCount = Object.keys(rankMap).length;
    console.log(
      `[API] Resolved ${resolvedCount} Discord accounts (${apiCalls} API calls, ${players.length - apiCalls} cached)`
    );

    await syncAllRoles();

    res.json({ success: true, leaderboard, resolvedCount, apiCalls });
  });

  // Receives player stats from Roblox (call on join and on leave)
  // Expected body: { userId: 123, username: "Player1", currency: 5000, rebirths: 3, crates: 10, playtime: 120 }
  app.post("/api/stats", async (req, res) => {
    if (req.headers.authorization !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId, username, ...stats } = req.body;

    if (!userId || !username) {
      return res.status(400).json({ error: "Missing userId or username" });
    }

    // Store stats
    playerStats.set(String(userId), { username, ...stats });

    // Also resolve and cache their Discord ID
    const wasCached = robloxToDiscordCache.has(String(userId));
    if (!wasCached) {
      await getDiscordIdsFromRoblox(userId);
    }

    console.log(`[Stats] Updated stats for ${username} (${userId})`);

    res.json({ success: true });
  });

  app.listen(PORT, () => {
    console.log(`[API] Server listening on port ${PORT}`);
  });
}

// ── Clear cache every 6 hours ──

setInterval(
  () => {
    robloxToDiscordCache.clear();
    discordToRobloxCache.clear();
    console.log("[Cache] Cleared Bloxlink cache");
  },
  6 * 60 * 60 * 1000
);

// ── Start ──

client.login(DISCORD_TOKEN);
