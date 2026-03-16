const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");

// ── Config ──

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const API_SECRET = process.env.API_SECRET;
const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY;
const PORT = process.env.PORT || 3000;

// Role IDs — set these in Railway variables
const TOP10_ROLE_ID = process.env.TOP10_ROLE_ID;
const TOP50_ROLE_ID = process.env.TOP50_ROLE_ID;
const TOP100_ROLE_ID = process.env.TOP100_ROLE_ID;

// ── Discord Client ──

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Tracks per leaderboard: { "Currency": { discordId: rank, ... }, ... }
const leaderboardData = {};

// Cache: Roblox user ID → Discord IDs (avoids repeat Bloxlink calls)
const robloxToDiscordCache = new Map();

client.once("ready", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  startServer();
});

// ── Bloxlink API (with cache) ──

async function getDiscordIdsFromRoblox(robloxUserId) {
  // Check cache first
  const cached = robloxToDiscordCache.get(String(robloxUserId));
  if (cached) {
    return cached;
  }

  try {
    const res = await fetch(
      `https://api.blox.link/v4/public/guilds/${GUILD_ID}/roblox-to-discord/${robloxUserId}`,
      {
        headers: {
          Authorization: BLOXLINK_API_KEY,
        },
      }
    );

    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      console.error(
        `[Bloxlink] Non-JSON response for user ${robloxUserId} (status ${res.status})`
      );
      return [];
    }

    const data = await res.json();

    if (data.discordIDs && Array.isArray(data.discordIDs)) {
      // Cache the result
      robloxToDiscordCache.set(String(robloxUserId), data.discordIDs);
      return data.discordIDs;
    }

    // Cache empty result too so we don't keep asking
    robloxToDiscordCache.set(String(robloxUserId), []);
    return [];
  } catch (err) {
    console.error(
      `[Bloxlink] Failed to look up Roblox user ${robloxUserId}:`,
      err.message
    );
    return [];
  }
}

// ── Role Logic ──

// Given a rank, returns which roles they should have
// Top 10 gets ALL three roles, Top 50 gets Top 50 + Top 100, Top 100 gets just Top 100
function getRolesForRank(rank) {
  const roles = [];
  if (rank <= 10) roles.push(TOP10_ROLE_ID, TOP50_ROLE_ID, TOP100_ROLE_ID);
  else if (rank <= 50) roles.push(TOP50_ROLE_ID, TOP100_ROLE_ID);
  else if (rank <= 100) roles.push(TOP100_ROLE_ID);
  return roles;
}

const ALL_TIER_ROLES = () => [TOP10_ROLE_ID, TOP50_ROLE_ID, TOP100_ROLE_ID];

// Get the best (lowest) rank for a Discord ID across all leaderboards
function getBestRank(discordId) {
  let best = Infinity;
  for (const ranks of Object.values(leaderboardData)) {
    if (ranks[discordId] !== undefined && ranks[discordId] < best) {
      best = ranks[discordId];
    }
  }
  return best === Infinity ? null : best;
}

// ── Role Management ──

async function syncAllRoles() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error(`[Roles] Guild ${GUILD_ID} not found`);
    return;
  }

  // Collect every Discord ID we've ever tracked
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

      // Add roles they should have
      for (const roleId of shouldHave) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId);
          console.log(
            `[Roles] Added role to ${member.user.tag} (rank #${bestRank})`
          );
        }
      }

      // Remove roles they shouldn't have
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

  // Receives leaderboard data from your Roblox game
  // Expected body: { leaderboard: "Currency", players: [{ userId: 123, rank: 1 }, ...] }
  // Send up to 100 players per leaderboard
  app.post("/api/leaderboard", async (req, res) => {
    // Auth check
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

    // Resolve Roblox user IDs → Discord user IDs via Bloxlink
    const rankMap = {}; // { discordId: rank }
    let apiCalls = 0;

    for (const player of players) {
      const wasCached = robloxToDiscordCache.has(String(player.userId));
      const discordIds = await getDiscordIdsFromRoblox(player.userId);

      if (!wasCached) apiCalls++;

      for (const id of discordIds) {
        // Keep the best (lowest) rank if they appear multiple times
        if (rankMap[id] === undefined || player.rank < rankMap[id]) {
          rankMap[id] = player.rank;
        }
      }

      // Small delay between non-cached API calls
      if (!wasCached) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Store this leaderboard's data
    leaderboardData[leaderboard] = rankMap;

    const resolvedCount = Object.keys(rankMap).length;
    console.log(
      `[API] Resolved ${resolvedCount} Discord accounts (${apiCalls} API calls, ${players.length - apiCalls} cached)`
    );

    // Sync all roles across all leaderboards
    await syncAllRoles();

    res.json({
      success: true,
      leaderboard,
      resolvedCount,
      apiCalls,
    });
  });

  app.listen(PORT, () => {
    console.log(`[API] Server listening on port ${PORT}`);
  });
}

// ── Clear cache every 6 hours so changes get picked up ──

setInterval(
  () => {
    robloxToDiscordCache.clear();
    console.log("[Cache] Cleared Bloxlink cache");
  },
  6 * 60 * 60 * 1000
);

// ── Start ──

client.login(DISCORD_TOKEN);
