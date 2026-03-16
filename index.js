const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");

// ── Config ──

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TOP10_ROLE_ID = process.env.TOP10_ROLE_ID;
const API_SECRET = process.env.API_SECRET;
const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY;
const PORT = process.env.PORT || 3000;

// ── Discord Client ──

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Tracks Discord IDs per leaderboard so one update doesn't wipe another
// Format: { "Currency": Set<discordId>, "Crates": Set<discordId>, ... }
const leaderboardSets = {};

// Combines all leaderboard sets into one flat set of Discord IDs
function getAllTop10Ids() {
  const combined = new Set();
  for (const ids of Object.values(leaderboardSets)) {
    for (const id of ids) {
      combined.add(id);
    }
  }
  return combined;
}

client.once("ready", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  startServer();
});

// ── Bloxlink API ──
// Endpoint: Roblox User ID → Discord User IDs (server-specific)
// Rate limit: 500 requests per day

async function getDiscordIdsFromRoblox(robloxUserId) {
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
      return data.discordIDs;
    }

    return [];
  } catch (err) {
    console.error(
      `[Bloxlink] Failed to look up Roblox user ${robloxUserId}:`,
      err.message
    );
    return [];
  }
}

// ── Role Management ──

async function updateRoles(leaderboardName, newDiscordIds) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error(`[Roles] Guild ${GUILD_ID} not found`);
    return;
  }

  // Get the old combined set (everyone who had the role across all leaderboards)
  const oldCombined = getAllTop10Ids();

  // Update this specific leaderboard's set
  leaderboardSets[leaderboardName] = new Set(newDiscordIds);

  // Get the new combined set
  const newCombined = getAllTop10Ids();

  // Remove role from players no longer in ANY top 10
  for (const discordId of oldCombined) {
    if (!newCombined.has(discordId)) {
      try {
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member && member.roles.cache.has(TOP10_ROLE_ID)) {
          await member.roles.remove(TOP10_ROLE_ID);
          console.log(`[Roles] Removed top 10 role from ${member.user.tag}`);
        }
      } catch (err) {
        console.error(
          `[Roles] Failed to remove role from ${discordId}:`,
          err.message
        );
      }
    }
  }

  // Add role to new top 10 players
  for (const discordId of newCombined) {
    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member && !member.roles.cache.has(TOP10_ROLE_ID)) {
        await member.roles.add(TOP10_ROLE_ID);
        console.log(`[Roles] Added top 10 role to ${member.user.tag}`);
      }
    } catch (err) {
      console.error(
        `[Roles] Failed to add role to ${discordId}:`,
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

  // Receives top 10 data from your Roblox game
  // Expected body: { leaderboard: "Currency", players: [{ userId: 123, rank: 1, username: "Player1" }, ...] }
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
      `[API] Received top ${players.length} for leaderboard: ${leaderboard}`
    );

    // Resolve Roblox user IDs → Discord user IDs via Bloxlink
    const allDiscordIds = [];

    for (const player of players) {
      const discordIds = await getDiscordIdsFromRoblox(player.userId);

      for (const id of discordIds) {
        allDiscordIds.push(id);
      }

      // Small delay to be respectful of rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(
      `[API] Resolved ${allDiscordIds.length} Discord accounts from ${players.length} Roblox users`
    );

    // Update roles for this specific leaderboard
    await updateRoles(leaderboard, allDiscordIds);

    res.json({
      success: true,
      leaderboard,
      resolvedCount: allDiscordIds.length,
    });
  });

  app.listen(PORT, () => {
    console.log(`[API] Server listening on port ${PORT}`);
  });
}

// ── Start ──

client.login(DISCORD_TOKEN);
