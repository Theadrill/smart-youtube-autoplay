// createPlaylistFromCache.js
// Gera uma playlist pública no YouTube com base no channelCache.json
// Requer: npm install googleapis open
/* 
const fs = require("fs")
const path = require("path")
const { google } = require("googleapis")
const open = require("open")

const CACHE_FILE = path.join(__dirname, "channelCache.json")
const TOKEN_PATH = path.join(__dirname, "token.json")

// Substitua com seu CLIENT_ID e CLIENT_SECRET do Google Cloud Console
const CLIENT_ID = "970493464825-kgcomgkk9vmodbgi9u0bl2ikd28g0bqr.apps.googleusercontent.com"
const CLIENT_SECRET = "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"
const REDIRECT_URI = "http://localhost:3000/oauth2callback"

 */

/**
 * Script: createPlaylistFromCache.js
 * Cria uma playlist pública no YouTube usando os vídeos do arquivo channelCache.json
 * Rodrigo — versão corrigida sem dependência de 'open'
 */

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { google } = require("googleapis")

const SCOPES = ["https://www.googleapis.com/auth/youtube"]
const TOKEN_PATH = path.join(__dirname, "token.json")
const CACHE_PATH = path.join(__dirname, "channelCache.json")

// 1️⃣ Lê suas credenciais
const CREDENTIALS_PATH = path.join(__dirname, "../credentials.json")
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"))
const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

// Função principal
async function main() {
    console.log("=== Criador de playlist a partir do cache ===")

    // Autenticação
    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
        oAuth2Client.setCredentials(token)
        console.log("[AUTH] Token existente carregado com sucesso.")
        await createPlaylist()
    } else {
        console.log("[AUTH] Nenhum token encontrado. É necessário autorizar o app.")
        await getAccessTokenManually()
    }
}

// 2️⃣ Função para pedir autorização manualmente
async function getAccessTokenManually() {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    })

    console.log("\nAbra este link no navegador e autorize o acesso:")
    console.log(authUrl)
    console.log("\nDepois de autorizar, copie o código que aparece após 'code=' e cole abaixo.\n")

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    rl.question("Cole o código aqui: ", async (code) => {
        rl.close()
        try {
            const { tokens } = await oAuth2Client.getToken(code.trim())
            oAuth2Client.setCredentials(tokens)
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
            console.log("[AUTH] Token salvo com sucesso em", TOKEN_PATH)
            await createPlaylist()
        } catch (err) {
            console.error("[ERRO] Falha ao obter token:", err.message)
        }
    })
}

// 3️⃣ Função para criar a playlist e adicionar os vídeos
async function createPlaylist() {
    const youtube = google.youtube({ version: "v3", auth: oAuth2Client })

    // Lê o cache de vídeos
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
    const allVideos = Object.values(cache)
        .flatMap((c) => c.videos || [])
        .map((v) => v.id)
        .filter(Boolean)

    console.log(`[INFO] Total de vídeos encontrados no cache: ${allVideos.length}`)
    if (allVideos.length === 0) {
        console.error("Nenhum vídeo encontrado no cache.")
        return
    }

    // Cria playlist
    console.log("[INFO] Criando playlist pública...")
    const playlistResponse = await youtube.playlists.insert({
        part: ["snippet", "status"],
        requestBody: {
            snippet: {
                title: "Playlist gerada automaticamente",
                description: "Gerada pelo Smart YouTube Autoplay",
            },
            status: {
                privacyStatus: "public",
            },
        },
    })

    const playlistId = playlistResponse.data.id
    console.log(`[OK] Playlist criada com ID: ${playlistId}`)

    // Adiciona vídeos
    for (const [i, videoId] of allVideos.entries()) {
        try {
            await youtube.playlistItems.insert({
                part: ["snippet"],
                requestBody: {
                    snippet: {
                        playlistId,
                        resourceId: {
                            kind: "youtube#video",
                            videoId,
                        },
                    },
                },
            })
            console.log(`[${i + 1}/${allVideos.length}] Adicionado: ${videoId}`)
        } catch (err) {
            console.warn(`[ERRO] Falha ao adicionar ${videoId}: ${err.message}`)
        }
    }

    console.log(`✅ Playlist criada com sucesso!`)
    console.log(`🔗 Link: https://www.youtube.com/playlist?list=${playlistId}`)
}

// Inicia o script
main().catch((err) => console.error("[FATAL]", err))
