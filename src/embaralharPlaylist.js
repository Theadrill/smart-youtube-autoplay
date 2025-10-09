/**
 * createShuffledPlaylist.js
 *
 * Gera uma playlist embaralhada com base no channelCache.json (se existir),
 * ou busca da playlist original se o cache não existir.
 */

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { google } = require("googleapis")

const SCOPES = ["https://www.googleapis.com/auth/youtube"]
const CREDENTIALS_PATH = path.join(__dirname, "..", "credentials.json")
const TOKEN_PATH = path.join(__dirname, "token.json")
const JOB_PATH = path.join(__dirname, "shuffle_job.json")
const CACHE_PATH = path.join(__dirname, "channelCache.json")

// === CONFIGURÁVEIS ===
const SOURCE_PLAYLIST_ID = "PLYx0204ec-6F9oVb-ikW6RBpnDzAGZslZ" // playlist de origem
const TARGET_PLAYLIST_TITLE = "Playlist Embaralhada - Smart Autoplay"
const TARGET_PLAYLIST_DESCRIPTION = "Gerada automaticamente a partir do cache local."
const TARGET_PLAYLIST_PRIVACY = "public"
const BATCH_ADD_DELAY_MS = 1500
// ======================

function readJsonSafe(p, def = null) {
    try {
        if (!fs.existsSync(p)) return def
        return JSON.parse(fs.readFileSync(p, "utf8"))
    } catch {
        return def
    }
}

function writeJsonSafe(p, obj) {
    fs.writeFileSync(p + ".tmp", JSON.stringify(obj, null, 2))
    fs.renameSync(p + ".tmp", p)
}

// --- Autenticação Google ---
async function getAuthenticatedClient() {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"))
    const data = creds.installed || creds.web
    const oAuth2Client = new google.auth.OAuth2(data.client_id, data.client_secret, data.redirect_uris[0])

    if (fs.existsSync(TOKEN_PATH)) {
        oAuth2Client.setCredentials(readJsonSafe(TOKEN_PATH))
        return oAuth2Client
    }

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
    })

    console.log("\nAbra este link e autorize o app:")
    console.log(authUrl)

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const code = await new Promise((resolve) =>
        rl.question("\nCole o código: ", (a) => {
            rl.close()
            resolve(a.trim())
        })
    )

    const { tokens } = await oAuth2Client.getToken(code)
    oAuth2Client.setCredentials(tokens)
    writeJsonSafe(TOKEN_PATH, tokens)
    console.log("[AUTH] Token salvo em", TOKEN_PATH)
    return oAuth2Client
}

// --- Utilidades de shuffle ---
function shuffleArrayInPlace(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[a[i], a[j]] = [a[j], a[i]]
    }
}

// regra de "1 vídeo por canal por rodada"
function buildRoundRobinShuffle(byChannel) {
    const channels = Object.keys(byChannel)
    for (const ch of channels) shuffleArrayInPlace(byChannel[ch])

    const out = []
    while (channels.length > 0) {
        shuffleArrayInPlace(channels)
        for (let i = channels.length - 1; i >= 0; i--) {
            const ch = channels[i]
            const bucket = byChannel[ch]
            if (!bucket || bucket.length === 0) {
                channels.splice(i, 1)
                delete byChannel[ch]
                continue
            }
            out.push(bucket.pop())
            if (bucket.length === 0) {
                channels.splice(i, 1)
                delete byChannel[ch]
            }
        }
    }
    return out
}

// --- API helpers ---
async function fetchAllPlaylistVideos(youtube, playlistId) {
    const items = []
    let pageToken = null
    do {
        const res = await youtube.playlistItems.list({
            part: ["snippet"],
            playlistId,
            maxResults: 50,
            pageToken: pageToken || undefined,
        })
        for (const it of res.data.items || []) {
            const id = it.snippet?.resourceId?.videoId
            const channelId = it.snippet?.videoOwnerChannelId || it.snippet?.channelId
            if (id && channelId) {
                items.push({ id, channelId })
            }
        }
        pageToken = res.data.nextPageToken
    } while (pageToken)
    return items
}

async function createPlaylistIfNeeded(youtube, job) {
    if (job.targetPlaylistId) {
        console.log("[INFO] Usando playlist destino existente:", job.targetPlaylistId)
        return job.targetPlaylistId
    }
    console.log("[INFO] Criando playlist destino...")
    const res = await youtube.playlists.insert({
        part: ["snippet", "status"],
        requestBody: {
            snippet: {
                title: TARGET_PLAYLIST_TITLE,
                description: TARGET_PLAYLIST_DESCRIPTION,
            },
            status: { privacyStatus: TARGET_PLAYLIST_PRIVACY },
        },
    })
    const pid = res.data.id
    job.targetPlaylistId = pid
    writeJsonSafe(JOB_PATH, job)
    console.log("[OK] Playlist criada:", pid)
    return pid
}

async function addVideoToPlaylist(youtube, playlistId, videoId) {
    await youtube.playlistItems.insert({
        part: ["snippet"],
        requestBody: {
            snippet: {
                playlistId,
                resourceId: { kind: "youtube#video", videoId },
            },
        },
    })
}

function groupByChannel(items) {
    const map = {}
    for (const it of items) {
        if (!map[it.channelId]) map[it.channelId] = []
        map[it.channelId].push(it.id)
    }
    return map
}

// --- Principal ---
async function main() {
    const auth = await getAuthenticatedClient()
    const youtube = google.youtube({ version: "v3", auth })

    // 1️⃣ Tenta usar o channelCache.json
    let cache = readJsonSafe(CACHE_PATH, null)
    let videos = []

    if (cache && Object.keys(cache).length > 0) {
        console.log("[CACHE] Usando vídeos de", CACHE_PATH)
        for (const ch in cache) {
            const vids = cache[ch].videos || []
            for (const v of vids) {
                if (v.id) videos.push({ id: v.id, channelId: ch })
            }
        }
    } else {
        console.log("[CACHE] Cache não encontrado, buscando playlist via API...")
        const fetched = await fetchAllPlaylistVideos(youtube, SOURCE_PLAYLIST_ID)
        console.log(`[API] ${fetched.length} vídeos carregados da playlist.`)
        cache = {}
        for (const v of fetched) {
            if (!cache[v.channelId]) cache[v.channelId] = { videos: [] }
            cache[v.channelId].videos.push({ id: v.id })
        }
        writeJsonSafe(CACHE_PATH, cache)
        videos = fetched
    }

    if (!videos.length) {
        console.error("Nenhum vídeo encontrado no cache ou playlist.")
        return
    }

    // 2️⃣ Monta o shuffle local
    const byChannel = groupByChannel(videos)
    const shuffledIds = buildRoundRobinShuffle(byChannel)
    console.log(`[PLAN] Embaralhamento completo: ${shuffledIds.length} vídeos.`)

    // 3️⃣ Carrega ou cria job
    let job = readJsonSafe(JOB_PATH, {
        sourcePlaylistId: SOURCE_PLAYLIST_ID,
        targetPlaylistId: null,
        shuffledIds,
        addedIds: [],
        nextIndex: 0,
    })

    if (!job.shuffledIds || job.shuffledIds.length !== shuffledIds.length) {
        job.shuffledIds = shuffledIds
        job.nextIndex = 0
        job.addedIds = []
    }

    // 4️⃣ Cria playlist destino se não existir
    const targetPlaylistId = await createPlaylistIfNeeded(youtube, job)

    // 5️⃣ Adiciona vídeos progressivamente
    for (let i = job.nextIndex; i < job.shuffledIds.length; i++) {
        const vid = job.shuffledIds[i]
        if (job.addedIds.includes(vid)) {
            console.log(`[SKIP] ${vid} já adicionado.`)
            continue
        }
        try {
            console.log(`[ADD] (${i + 1}/${job.shuffledIds.length}) Adicionando ${vid}...`)
            await addVideoToPlaylist(youtube, targetPlaylistId, vid)
            job.addedIds.push(vid)
            job.nextIndex = i + 1
            writeJsonSafe(JOB_PATH, job)
            await new Promise((r) => setTimeout(r, BATCH_ADD_DELAY_MS))
        } catch (err) {
            const msg = err.message || JSON.stringify(err)
            console.error(`[ERRO] ${vid}: ${msg}`)
            if (msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("exceeded")) {
                console.error("[STOP] Quota atingida. Salvando progresso e encerrando.")
                writeJsonSafe(JOB_PATH, job)
                process.exit(0)
            }
        }
    }

    console.log("✅ Processo concluído com sucesso!")
    console.log("Playlist final:", `https://www.youtube.com/playlist?list=${targetPlaylistId}`)
}

main().catch((e) => {
    console.error("[FATAL]", e)
    process.exit(1)
})
