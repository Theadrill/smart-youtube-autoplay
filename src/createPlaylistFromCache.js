/**
 * Script: createPlaylistFromCache.js
 * Sincroniza o cache local com uma playlist pública do YouTube.
 * - Usa somente a API do YouTube (sem RSS)
 * - Mantém um arquivo local playlist.json com os IDs já adicionados
 * - Remove duplicados online e do arquivo local
 * - Adiciona apenas vídeos novos
 * - Encerra imediatamente se a cota da API for atingida
 */

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { google } = require("googleapis")

// ======================= CONFIGURAÇÕES =======================
const PLAYLIST_ID = "PLYx0204ec-6F9oVb-ikW6RBpnDzAGZslZ" // <-- sua playlist
const SCOPES = ["https://www.googleapis.com/auth/youtube"]
const TOKEN_PATH = path.join(__dirname, "token.json")
const CACHE_PATH = path.join(__dirname, "channelCache.json")
const PLAYLIST_LOG_PATH = path.join(__dirname, "playlist.json")
const CREDENTIALS_PATH = path.join(__dirname, "../credentials.json")
// =============================================================

// --- Lê credenciais ---
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"))
const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

// --- Função principal ---
async function main() {
    console.log("=== Gerador de Playlist (modo API total) ===")

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
        oAuth2Client.setCredentials(token)
        console.log("[AUTH] Token carregado com sucesso.")
        await runPlaylistSync()
    } else {
        console.log("[AUTH] Nenhum token encontrado. É necessário autorizar o app.")
        await getAccessTokenManually()
    }
}

// --- Autorização manual (sem open) ---
async function getAccessTokenManually() {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    })

    console.log("\nAbra este link no navegador e autorize o acesso:")
    console.log(authUrl)
    console.log("\nDepois de autorizar, copie o código que aparece após 'code=' e cole abaixo.\n")

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    rl.question("Cole o código aqui: ", async (code) => {
        rl.close()
        try {
            const { tokens } = await oAuth2Client.getToken(code.trim())
            oAuth2Client.setCredentials(tokens)
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
            console.log("[AUTH] Token salvo em", TOKEN_PATH)
            await runPlaylistSync()
        } catch (err) {
            console.error("[ERRO] Falha ao obter token:", err.message)
        }
    })
}

// --- Função principal de sincronização ---
async function runPlaylistSync() {
    const youtube = google.youtube({ version: "v3", auth: oAuth2Client })

    // Lê cache local
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
    const allVideos = Object.values(cache)
        .flatMap((c) => c.videos || [])
        .map((v) => v.id)
        .filter(Boolean)

    if (allVideos.length === 0) return console.error("Nenhum vídeo encontrado no cache.")

    console.log(`[INFO] Total de vídeos encontrados no cache: ${allVideos.length}`)

    // Lê playlist local
    let playlistLocal = []
    if (fs.existsSync(PLAYLIST_LOG_PATH)) {
        playlistLocal = JSON.parse(fs.readFileSync(PLAYLIST_LOG_PATH, "utf8"))
    }

    console.log(`[INFO] IDs já registrados no arquivo local: ${playlistLocal.length}`)

    // Obtém vídeos da playlist via API
    console.log("[INFO] Buscando vídeos atuais da playlist no YouTube...")
    const existingOnline = await safeApiCall(() => fetchAllVideosFromPlaylist(youtube, PLAYLIST_ID))
    console.log(`[INFO] ${existingOnline.length} vídeos encontrados na playlist online.`)

    // Remove duplicados online (mantém apenas o primeiro)
    await safeApiCall(() => removeDuplicateVideos(youtube, PLAYLIST_ID, existingOnline))

    // Atualiza log local com base no estado atual da playlist
    const unifiedSet = new Set([...playlistLocal, ...existingOnline.map((v) => v.videoId)])
    fs.writeFileSync(PLAYLIST_LOG_PATH, JSON.stringify(Array.from(unifiedSet), null, 2))

    // Adiciona vídeos que ainda não estão nem no log nem online
    const newVideos = allVideos.filter((id) => !unifiedSet.has(id))
    console.log(`[INFO] ${newVideos.length} vídeos novos serão adicionados.`)

    for (const [i, videoId] of newVideos.entries()) {
        await safeApiCall(async () => {
            await youtube.playlistItems.insert({
                part: ["snippet"],
                requestBody: {
                    snippet: {
                        playlistId: PLAYLIST_ID,
                        resourceId: { kind: "youtube#video", videoId },
                    },
                },
            })
            console.log(`[${i + 1}/${newVideos.length}] ✅ Adicionado: ${videoId}`)
            unifiedSet.add(videoId)
            fs.writeFileSync(PLAYLIST_LOG_PATH, JSON.stringify(Array.from(unifiedSet), null, 2))
        })
    }

    console.log("✅ Sincronização concluída!")
    console.log(`🔗 Playlist: https://www.youtube.com/playlist?list=${PLAYLIST_ID}`)
}

/**
 * Executa chamadas à API com proteção contra quotaExceeded.
 * Se a quota for atingida, o app é finalizado imediatamente.
 */
async function safeApiCall(fn) {
    try {
        return await fn()
    } catch (err) {
        const msg = err?.message || ""
        if (msg.includes("because you have exceeded your") || msg.includes("403")) {
            console.error("\n🚨 [FATAL] A cota da API do YouTube foi atingida.")
            console.error("Encerrando o aplicativo para evitar requisições desnecessárias.\n")
            process.exit(1)
        }
        console.error("[ERRO API]", msg)
        return []
    }
}

// --- Busca todos os vídeos da playlist via API ---
async function fetchAllVideosFromPlaylist(youtube, playlistId) {
    let all = []
    let nextPageToken = null
    let page = 0

    do {
        page++
        const res = await youtube.playlistItems.list({
            part: ["contentDetails", "id"],
            playlistId,
            maxResults: 50,
            pageToken: nextPageToken || "",
        })

        const items = (res.data.items || []).map((i) => ({
            playlistItemId: i.id,
            videoId: i.contentDetails?.videoId,
        }))
        all = [...all, ...items]
        nextPageToken = res.data.nextPageToken || null
        console.log(`[PAGE ${page}] Obtidos ${items.length} vídeos (total ${all.length})`)
    } while (nextPageToken)

    return all
}

// --- Remove vídeos duplicados online ---
async function removeDuplicateVideos(youtube, playlistId, items) {
    const seen = new Set()
    const duplicates = []

    for (const item of items) {
        if (seen.has(item.videoId)) duplicates.push(item)
        else seen.add(item.videoId)
    }

    if (duplicates.length === 0) {
        console.log("[INFO] Nenhum vídeo duplicado encontrado.")
        return
    }

    console.log(`[WARN] Removendo ${duplicates.length} duplicados da playlist...`)

    for (const dup of duplicates) {
        try {
            await youtube.playlistItems.delete({ id: dup.playlistItemId })
            console.log(`❌ Removido duplicado: ${dup.videoId}`)
        } catch (err) {
            console.warn(`[ERRO] Falha ao remover duplicado ${dup.videoId}: ${err.message}`)
        }
    }
}

// --- Inicia o script ---
main().catch((err) => console.error("[FATAL]", err))
