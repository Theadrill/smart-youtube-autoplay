// src/selector.js
const storage = require("./storage")
const { readJsonSafe, writeJsonSafe } = require("./storage")
const path = require("path")
const youtubeApi = require("./youtubeApi")
const rssService = require("./rssService")

const CONFIG_PATH = storage.configPath
const PLAYED_PATH = storage.playedPath

function now() {
    return Date.now()
}

function loadConfig() {
    return readJsonSafe(CONFIG_PATH, {})
}
function loadPlayed() {
    return readJsonSafe(PLAYED_PATH, {})
}
function savePlayed(obj) {
    return writeJsonSafe(PLAYED_PATH, obj)
}

// pick a channel with respect to weight
function pickWeightedChannel(channels) {
    if (!channels || channels.length === 0) return null
    const pool = []
    channels.forEach((c) => {
        const w = c.weight && Number.isFinite(c.weight) ? Math.max(1, Math.floor(c.weight)) : 1
        for (let i = 0; i < w; i++) pool.push(c)
    })
    return pool[Math.floor(Math.random() * pool.length)]
}

// helper: isWithinMaxAgeYears
function withinMaxAge(published, maxYears) {
    if (!published) return false
    const cutoff = now() - maxYears * 365 * 24 * 60 * 60 * 1000
    return published >= cutoff
}

// main: getNextVideo — tenta API, fallback RSS, aplica regras e relaxa se necessário
async function getNextVideo(options = {}) {
    const cfg = loadConfig()
    const played = loadPlayed()
    const channels = cfg.channels || []
    const maxAgeYears = cfg.maxAgeYears || 2
    const minViews = cfg.minViews || 0
    const cacheTtl = cfg.cacheTtlMinutes || 15
    const attemptsBeforeRelax = cfg.attemptsBeforeRelax || 6
    const maxSearchResults = cfg.maxSearchResults || 100
    const playedResetDays = cfg.playedResetDays || 60

    if (channels.length === 0) throw new Error("Nenhum canal configurado em config.json -> channels")

    // simple in-memory cache (per runtime)
    if (!global.__sya_cache) global.__sya_cache = { fetchedAt: {}, videos: {} }

    const tried = new Set()
    let relax = false
    let tries = 0
    const maxTries = channels.length * 3

    while (tries < maxTries) {
        tries++
        const channel = pickWeightedChannel(channels)
        if (!channel) break
        if (tried.has(channel.id) && tried.size < channels.length) continue // prefer variety
        tried.add(channel.id)

        // caching: if cached and fresh, use it
        const cacheEntry = global.__sya_cache.fetchedAt[channel.id]
        const age = cacheEntry ? (Date.now() - cacheEntry) / (60 * 1000) : Infinity
        let videos = []
        try {
            if (cacheEntry && age < cacheTtl) {
                videos = global.__sya_cache.videos[channel.id] || []
            } else {
                // prefer API if available
                try {
                    const vids = await youtubeApi.fetchChannelVideosViaApi(channel.id, maxSearchResults)
                    videos = vids
                } catch (apiErr) {
                    // fallback to RSS
                    try {
                        const vids2 = await rssService.fetchChannelVideosViaRSS(channel.id)
                        videos = vids2
                    } catch (rssErr) {
                        // use whatever cached if exists
                        videos = global.__sya_cache.videos[channel.id] || []
                    }
                }
                // update cache
                global.__sya_cache.fetchedAt[channel.id] = Date.now()
                global.__sya_cache.videos[channel.id] = videos
            }
        } catch (err) {
            console.warn("Erro ao obter vídeos para canal", channel.id, err)
            continue
        }

        if (!videos || videos.length === 0) continue

        // Filter pipeline
        // 1) by max age
        let candidates = videos.filter((v) => withinMaxAge(v.published, maxAgeYears))

        // 2) by embeddable true if available information exists
        if (!relax) {
            const withEmbeddableKnown = candidates.filter((v) => v.embeddable !== null)
            if (withEmbeddableKnown.length > 0) {
                candidates = candidates.filter((v) => v.embeddable === true)
            }
        }

        // 3) by minViews if known
        if (!relax && minViews > 0) {
            const withViewsKnown = candidates.filter((v) => v.viewCount !== null && typeof v.viewCount === "number")
            if (withViewsKnown.length > 0) {
                candidates = candidates.filter((v) => (v.viewCount || 0) >= minViews)
            }
        }

        // 4) exclude recently played
        const playedCutoff = Date.now() - playedResetDays * 24 * 60 * 60 * 1000
        candidates = candidates.filter((v) => !(played[v.id] && played[v.id] >= playedCutoff))

        // if empty and we haven't relaxed yet, maybe set relax based on tried count
        if (candidates.length === 0 && !relax) {
            if (tried.size >= Math.min(attemptsBeforeRelax, channels.length)) {
                relax = true
            }
        }

        // if still empty but relax = true, progressively loosen filters
        if (candidates.length === 0 && relax) {
            // allow embeddable false/unknown and any view count, but keep maxAge
            candidates = videos.filter((v) => withinMaxAge(v.published, maxAgeYears))
        }

        if (candidates.length === 0 && relax) {
            // as last resort, allow ignoring maxAge entirely
            candidates = videos.slice()
        }

        if (candidates.length === 0) continue

        // pick random candidate
        const chosen = candidates[Math.floor(Math.random() * candidates.length)]

        // return minimal info
        return {
            videoId: chosen.id,
            title: chosen.title,
            channelId: chosen.channelId || channel.id,
            published: chosen.published || null,
            durationSeconds: chosen.durationSeconds || null,
            viewCount: chosen.viewCount || null,
            embeddable: chosen.embeddable,
        }
    }

    // Se nada encontrado:
    return null
}

// mark played
function markPlayed(videoId) {
    const played = loadPlayed()
    played[videoId] = Date.now()
    savePlayed(played)
}

module.exports = {
    getNextVideo,
    markPlayed,
}
