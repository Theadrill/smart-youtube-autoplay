// src/selector.js
const storage = require("./storage")
const { readJsonSafe, writeJsonSafe } = require("./storage")
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

// --- NOVA VERSÃO: busca todos os canais primeiro com prioridade para canais não tocados ---
async function getNextVideo() {
    const cfg = loadConfig()
    const played = loadPlayed()
    const channels = cfg.channels || []
    const maxAgeYears = cfg.maxAgeYears || 2
    const minViews = cfg.minViews || 0
    const playedResetDays = cfg.playedResetDays || 60
    const attemptsBeforeRelax = cfg.attemptsBeforeRelax || 6
    const cacheTtl = cfg.cacheTtlMinutes || 15
    const maxSearchResults = cfg.maxSearchResults || 100

    if (channels.length === 0) throw new Error("Nenhum canal configurado em config.json -> channels")

    // --- CACHE EM MEMÓRIA ---
    if (!global.__sya_cache) global.__sya_cache = { fetchedAt: {}, videos: {} }

    const allCandidates = []
    const channelHasPlayed = {}

    console.log(`[INFO] Iniciando busca de vídeos. Total de canais: ${channels.length}`)

    // --- percorre todos os canais ---
    for (const channel of channels) {
        try {
            const cacheEntry = global.__sya_cache.fetchedAt[channel.id]
            const age = cacheEntry ? (now() - cacheEntry) / (60 * 1000) : Infinity
            let videos = []

            if (cacheEntry && age < cacheTtl) {
                videos = global.__sya_cache.videos[channel.id] || []
                console.log(`[CACHE] Canal ${channel.id}: usando cache com ${age.toFixed(1)} min de idade, vídeos: ${videos.length}`)
            } else {
                try {
                    videos = await youtubeApi.fetchChannelVideosViaApi(channel.id)
                    console.log(`[API] Canal ${channel.id}: vídeos obtidos via API: ${videos.length}`)
                } catch (apiErr) {
                    console.warn(`[API] Erro API canal ${channel.id}, tentando RSS`, apiErr)
                    try {
                        videos = await rssService.fetchChannelVideosViaRSS(channel.id)
                        console.log(`[RSS] Canal ${channel.id}: vídeos obtidos via RSS: ${videos.length}`)
                    } catch (rssErr) {
                        console.warn(`[RSS] Erro RSS canal ${channel.id}`, rssErr)
                        videos = global.__sya_cache.videos[channel.id] || []
                    }
                }
                global.__sya_cache.fetchedAt[channel.id] = now()
                global.__sya_cache.videos[channel.id] = videos
            }

            if (!videos || videos.length === 0) continue

            // --- FILTROS ---
            let candidates = videos.filter((v) => withinMaxAge(v.published, maxAgeYears))
            candidates = candidates.filter((v) => v.durationSeconds !== null)
            candidates = candidates.filter((v) => !(played[v.id] && played[v.id] >= now() - playedResetDays * 24 * 60 * 60 * 1000))
            if (minViews > 0) candidates = candidates.filter((v) => (v.viewCount || 0) >= minViews)

            console.log(`[FILTER] Canal ${channel.id}: ${candidates.length}/${videos.length} vídeos após filtros`)

            // registra se o canal já teve algum vídeo tocado
            const hasPlayedAny = videos.some((v) => played[v.id])
            channelHasPlayed[channel.id] = hasPlayedAny
            if (hasPlayedAny) {
                console.log(`[INFO] Canal ${channel.id} já teve vídeos tocados`)
            } else {
                console.log(`[INFO] Canal ${channel.id} ainda não teve vídeos tocados`)
            }

            allCandidates.push(...candidates.map((v) => ({ ...v, weight: channel.weight || 1, channelId: channel.id })))
        } catch (err) {
            console.warn(`[ERROR] ao processar canal ${channel.id}:`, err)
        }
    }

    if (allCandidates.length === 0) {
        console.warn("[NEXT] Nenhum vídeo candidato encontrado após filtros, relaxando regras...")
        for (const channel of channels) {
            const videos = global.__sya_cache.videos[channel.id] || []
            const candidates = videos.filter((v) => withinMaxAge(v.published, maxAgeYears))
            allCandidates.push(...candidates.map((v) => ({ ...v, weight: channel.weight || 1, channelId: channel.id })))
        }
    }

    if (allCandidates.length === 0) {
        console.warn("[NEXT] Nenhum vídeo disponível mesmo após relax")
        return null
    }

    // --- PRIORIDADE: canais que ainda não tiveram vídeos tocados ---
    const untouchedCandidates = allCandidates.filter((v) => !channelHasPlayed[v.channelId])
    console.log(`[PRIORITY] Vídeos de canais não tocados: ${untouchedCandidates.length}/${allCandidates.length}`)

    const finalPool = untouchedCandidates.length > 0 ? untouchedCandidates : allCandidates

    // --- pick weighted random ---
    const weightedPool = []
    finalPool.forEach((v) => {
        const w = Math.max(1, v.weight || 1)
        for (let i = 0; i < w; i++) weightedPool.push(v)
    })

    const chosen = weightedPool[Math.floor(Math.random() * weightedPool.length)]
    console.log(`[NEXT] Escolhido vídeo: ${chosen.title} (canal ${chosen.channelId}, peso ${chosen.weight})`)

    return {
        videoId: chosen.id,
        title: chosen.title,
        channelId: chosen.channelId,
        published: chosen.published || null,
        durationSeconds: chosen.durationSeconds || null,
        viewCount: chosen.viewCount || null,
        embeddable: chosen.embeddable,
    }
}

function markPlayed(videoId) {
    const played = loadPlayed()
    played[videoId] = now()
    savePlayed(played)
    console.log(`[MARK PLAYED] Vídeo ${videoId} marcado como reproduzido`)
}

module.exports = {
    getNextVideo,
    markPlayed,
}
