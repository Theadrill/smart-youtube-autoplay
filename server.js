// server.js
const express = require("express")
const bodyParser = require("body-parser")
const cors = require("cors")
const path = require("path")
const fs = require("fs")

const storage = require("./src/storage")
const selector = require("./src/selector")
const { readJsonSafe, writeJsonSafe } = require("./src/storage")

const livereload = require("livereload")
const connectLivereload = require("connect-livereload")

// Cria o servidor de live reload na porta 35729 (padrão)
const liveReloadServer = livereload.createServer()
liveReloadServer.watch(path.join(__dirname, "../public"))

const app = express()

// Injetar script de live reload no Express
app.use(connectLivereload())

app.use(cors())
app.use(bodyParser.json())
app.use(express.static(path.join(__dirname, "public")))

// GET /api/next -> retorna próximo vídeo elegível
app.get("/api/next", async (req, res) => {
    try {
        const next = await selector.getNextVideo()
        if (!next) return res.status(404).json({ error: "Nenhum vídeo disponível no momento." })
        return res.json(next)
    } catch (err) {
        console.error("Erro /api/next", err)
        return res.status(500).json({ error: "Erro interno ao buscar próximo vídeo: " + err.message })
    }
})

// POST /api/played { videoId }
app.post("/api/played", (req, res) => {
    const { videoId } = req.body || {}
    if (!videoId) return res.status(400).json({ error: "videoId required" })
    try {
        selector.markPlayed(videoId)
        return res.json({ ok: true })
    } catch (err) {
        console.error("Erro /api/played", err)
        return res.status(500).json({ error: "Erro marcando played" })
    }
})

// Admin endpoints simples
app.post("/api/admin/channel", (req, res) => {
    const { id, title, weight } = req.body || {}
    if (!id) return res.status(400).json({ error: "channel id required" })
    const cfg = readJsonSafe(storage.configPath, {})
    cfg.channels = cfg.channels || []
    if (cfg.channels.find((c) => c.id === id)) return res.status(400).json({ error: "canal já cadastrado" })
    cfg.channels.push({ id, title: title || id, weight: weight || 1 })
    writeJsonSafe(storage.configPath, cfg)
    return res.json({ ok: true, channels: cfg.channels })
})

app.get("/api/admin/channels", (req, res) => {
    const cfg = readJsonSafe(storage.configPath, {})
    return res.json(cfg.channels || [])
})

const cfg = readJsonSafe(storage.configPath, {})
const PORT = process.env.PORT || cfg.port || 3000

app.listen(PORT, () => {
    console.log(`Smart YouTube Autoplay server rodando na porta ${PORT}`)
    console.log(`Abra http://localhost:${PORT}/ no navegador (ou a URL do seu TV box)`)
})
