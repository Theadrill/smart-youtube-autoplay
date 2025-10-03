// src/youtubeApi.js
const fetch = require("node-fetch")
const fs = require("fs")
const path = require("path")
const { readJsonSafe } = require("./storage")
const storage = require("./storage")

// lê a config para minDurationSeconds
const config = readJsonSafe(storage.configPath, {})
const minDurationSeconds = config.minDurationSeconds || 0

// caminho do cache de vídeos por canal
const cachePath = path.join(__dirname, "channelCache.json")

function getApiKey() {
    const creds = readJsonSafe(storage.credentialsPath, {})
    return creds.YOUTUBE_API_KEY || ""
}

// helper: duration ISO8601 -> seconds
function isoDurationToSeconds(iso) {
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
    if (!match) return 0
    const hours = parseInt(match[1] || 0, 10)
    const mins = parseInt(match[2] || 0, 10)
    const secs = parseInt(match[3] || 0, 10)
    return hours * 3600 + mins * 60 + secs
}

// busca vídeos recentes do canal (search.list -> videos.list para detalhes)
async function fetchChannelVideosViaApi(channelId, maxResults = 100) {
    const key = getApiKey()
    if (!key) throw new Error("No API key")

    // TENTA CARREGAR CACHE
    let cache = {}
    try {
        cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"))
    } catch (err) {
        // ignora se não existir
    }

    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000

    if (cache[channelId] && now - cache[channelId].lastFetch < oneDay) {
        console.log(`[CACHE] Usando cache do canal ${channelId}`)
        return cache[channelId].videos
    }

    // se não tiver cache ou estiver expirado, busca na API
    try {
        console.log(`[API] Buscando vídeos do canal ${channelId}`)
        // search.list para pegar IDs
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=${Math.min(maxResults, 100)}&order=date&type=video&key=${key}`
        const r1 = await fetch(searchUrl)
        if (!r1.ok) {
            const txt = await r1.text().catch(() => null)
            throw new Error("search.list failed: " + r1.status + " " + txt)
        }
        const data = await r1.json()
        const ids = (data.items || []).map((i) => i.id.videoId).filter(Boolean)
        if (ids.length === 0) return []

        // videos.list para detalhes
        const idsParam = ids.join(",")
        const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,status&id=${encodeURIComponent(idsParam)}&key=${key}`
        const r2 = await fetch(videosUrl)
        if (!r2.ok) {
            const txt = await r2.text().catch(() => null)
            throw new Error("videos.list failed: " + r2.status + " " + txt)
        }
        const vd = await r2.json()

        const videos = (vd.items || []).map((item) => {
            const durationSec = item.contentDetails ? isoDurationToSeconds(item.contentDetails.duration) : null

            return {
                id: item.id,
                title: item.snippet && item.snippet.title,
                published: item.snippet && Date.parse(item.snippet.publishedAt),
                durationSeconds: durationSec,
                viewCount: item.statistics && item.statistics.viewCount ? parseInt(item.statistics.viewCount, 10) : 0,
                embeddable: item.status && typeof item.status.embeddable !== "undefined" ? Boolean(item.status.embeddable) : null,
                channelId: item.snippet && item.snippet.channelId,
            }
        })

        // filtra vídeos curtos (Shorts)
        const filteredVideos = videos.filter((v) => {
            if (v.durationSeconds === null) return false
            if (v.durationSeconds < minDurationSeconds) {
                console.log(`⏩ Ignorando vídeo curto/Short: ${v.title} (${v.durationSeconds}s)`)
                return false
            }
            return true
        })

        // ATUALIZA CACHE
        cache[channelId] = {
            lastFetch: now,
            videos: filteredVideos,
        }
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2))

        return filteredVideos
    } catch (err) {
        throw err
    }
}

module.exports = {
    fetchChannelVideosViaApi,
}
