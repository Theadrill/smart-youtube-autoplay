const fetch = require("node-fetch")
const fs = require("fs")
const path = require("path")
const { readJsonSafe } = require("./storage")
const storage = require("./storage")

// lê a config
const config = readJsonSafe(storage.configPath, {})
const minDurationSeconds = config.minDurationSeconds || 0
const maxSearchResults = config.maxSearchResults || 100
const cacheTtlMinutes = config.cacheTtlMinutes || 15

// caminho do cache de vídeos por canal
const cachePath = path.join(__dirname, "channelCache.json")

// helper: duration ISO8601 -> seconds
function isoDurationToSeconds(iso) {
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
    if (!match) return 0
    const hours = parseInt(match[1] || 0, 10)
    const mins = parseInt(match[2] || 0, 10)
    const secs = parseInt(match[3] || 0, 10)
    return hours * 3600 + mins * 60 + secs
}

function getApiKey() {
    const creds = readJsonSafe(storage.credentialsPath, {})
    return creds.YOUTUBE_API_KEY || ""
}

// Função principal para buscar vídeos de um canal
async function fetchChannelVideosViaApi(channelId) {
    const key = getApiKey()
    if (!key) throw new Error("No API key")

    // tenta carregar cache
    let cache = {}
    try {
        cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"))
    } catch (err) {
        // ignora se não existir
    }

    const now = Date.now()
    const cacheTtlMs = cacheTtlMinutes * 60 * 1000

    if (cache[channelId] && now - cache[channelId].lastFetch < cacheTtlMs) {
        const ageMs = now - cache[channelId].lastFetch
        console.log(`[CACHE] Canal ${channelId}: usando cache com ${(ageMs / 1000 / 60).toFixed(1)} min de idade`)
        return cache[channelId].videos
    }

    try {
        console.log(`[API] Buscando vídeos do canal ${channelId}`)
        let videos = []
        let totalFetched = 0
        let nextPageToken = undefined
        let page = 0

        do {
            page++
            const fetchCount = Math.min(50, maxSearchResults - totalFetched)
            const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=${fetchCount}&order=date&type=video${nextPageToken ? `&pageToken=${nextPageToken}` : ""}&key=${key}`

            const r1 = await fetch(searchUrl)
            if (!r1.ok) {
                const txt = await r1.text().catch(() => null)
                throw new Error(`search.list failed: ${r1.status} ${txt}`)
            }

            const data = await r1.json()
            const ids = (data.items || []).map((i) => i.id.videoId).filter(Boolean)
            console.log(`[API] Canal ${channelId}: página ${page}, IDs obtidos: ${ids.length}`)

            if (!ids.length) break

            // busca detalhes
            const idsParam = ids.join(",")
            const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,status&id=${encodeURIComponent(idsParam)}&key=${key}`
            const r2 = await fetch(videosUrl)
            if (!r2.ok) {
                const txt = await r2.text().catch(() => null)
                throw new Error(`videos.list failed: ${r2.status} ${txt}`)
            }

            const vd = await r2.json()
            const fetchedVideos = (vd.items || []).map((item) => {
                const durationSec = item.contentDetails ? isoDurationToSeconds(item.contentDetails.duration) : null
                return {
                    id: item.id,
                    title: item.snippet?.title,
                    published: item.snippet ? Date.parse(item.snippet.publishedAt) : null,
                    durationSeconds: durationSec,
                    viewCount: item.statistics?.viewCount ? parseInt(item.statistics.viewCount, 10) : 0,
                    embeddable: item.status?.embeddable ?? null,
                    channelId: item.snippet?.channelId,
                }
            })

            videos = [...videos, ...fetchedVideos]
            totalFetched += fetchedVideos.length
            console.log(`[API] Canal ${channelId}: vídeos acumulados: ${videos.length}`)

            nextPageToken = data.nextPageToken
            if (!nextPageToken) {
                console.log(`[API] Canal ${channelId}: última página atingida.`)
                break
            }
            if (totalFetched >= maxSearchResults) {
                console.log(`[API] Canal ${channelId}: atingido maxSearchResults (${maxSearchResults})`)
                break
            }
        } while (true)

        // filtra vídeos curtos
        const filteredVideos = videos.filter((v) => {
            if (v.durationSeconds === null) return false
            if (v.durationSeconds < minDurationSeconds) {
                console.log(`⏩ Ignorando vídeo curto/Short: ${v.title} (${v.durationSeconds}s)`)
                return false
            }
            return true
        })

        console.log(`[API] Canal ${channelId}: total vídeos válidos após filtro: ${filteredVideos.length}`)

        // atualiza cache
        cache[channelId] = {
            lastFetch: now,
            videos: filteredVideos,
        }
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2))

        return filteredVideos
    } catch (err) {
        console.error(`[ERROR] fetchChannelVideosViaApi canal ${channelId}:`, err)
        return []
    }
}

module.exports = {
    fetchChannelVideosViaApi,
}
