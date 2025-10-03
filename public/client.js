// public/client.js
;(function () {
    // -------------------------
    // Configurações locais
    // -------------------------
    const PRELOAD_SECONDS_BEFORE_END = 8
    const SAFETY_PREFETCH_TIMEOUT_MS = 5000
    const SAFETY_VIDEO_TIMEOUT_MS = 1000 * 60 * 5
    const PREFETCH_RETRY_MS = 10000

    // -------------------------
    // Helpers de UI
    // -------------------------
    const overlayEl = document.getElementById("overlay")
    const debugEl = document.getElementById("debug")
    function overlay(text) {
        if (overlayEl) overlayEl.innerText = text
    }
    function debug(text) {
        if (debugEl) debugEl.innerText = typeof text === "string" ? text : JSON.stringify(text, null, 2)
        console.log("[DEBUG]", text)
    }

    // -------------------------
    // Estado
    // -------------------------
    let player = null
    let currentVideoId = null
    let upcoming = null
    let prefetchTimer = null
    let videoSafetyTimer = null
    let keepRunning = true
    let lastPrefetchAttempt = 0
    let forcedIntervalTimer = null

    // -------------------------
    // Chamada ao servidor
    // -------------------------
    async function fetchNextFromServer() {
        try {
            const res = await fetch("/api/next")
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                overlay("Nenhum vídeo: " + (body.error || res.status))
                console.warn("[SERVER] Nenhum vídeo:", body)
                return null
            }
            const data = await res.json()
            console.log("[SERVER] Próximo vídeo recebido:", data)
            return data
        } catch (err) {
            overlay("Erro rede ao buscar próximo. Tentando em " + PREFETCH_RETRY_MS / 1000 + "s")
            console.warn("fetchNext error", err)
            return null
        }
    }

    // -------------------------
    // Marca como reproduzido no servidor
    // -------------------------
    async function markPlayed(videoId) {
        try {
            await fetch("/api/played", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ videoId }),
            })
            console.log("[MARK] Vídeo marcado como reproduzido:", videoId)
        } catch (err) {
            console.warn("Erro marcando played", err)
        }
    }

    // -------------------------
    // Prefetch do próximo vídeo
    // -------------------------
    async function prefetchNext() {
        const now = Date.now()
        if (now - lastPrefetchAttempt < 2000) return
        lastPrefetchAttempt = now

        if (upcoming) return

        overlay("Pré-carregando próximo vídeo...")
        console.log("[PREFETCH] Tentando buscar próximo...")
        try {
            const next = await fetchNextFromServer()
            if (!next || next.videoId === currentVideoId) {
                console.log("[PREFETCH] Nenhum novo vídeo ou igual ao atual, retry em 2s")
                setTimeout(() => {
                    if (keepRunning) prefetchNext()
                }, 2000)
                return
            }
            upcoming = next
            debug({ upcoming })
            overlay("Próximo pré-carregado: " + (next.title || next.videoId))
        } catch (err) {
            console.warn("prefetch erro", err)
            overlay("Prefetch falhou, tentarei de novo...")
            setTimeout(() => {
                if (keepRunning) prefetchNext()
            }, PREFETCH_RETRY_MS)
        }
    }

    // -------------------------
    // Agendador de prefetch baseado na duração do vídeo
    // -------------------------
    function schedulePrefetch() {
        if (prefetchTimer) {
            clearTimeout(prefetchTimer)
            prefetchTimer = null
        }
        if (upcoming) return
        try {
            if (!player || typeof player.getDuration !== "function") {
                prefetchTimer = setTimeout(schedulePrefetch, 2000)
                return
            }
            const duration = player.getDuration()
            if (!duration || isNaN(duration) || duration <= PRELOAD_SECONDS_BEFORE_END + 1) {
                prefetchTimer = setTimeout(prefetchNext, 500)
                return
            }
            const whenMs = Math.max(200, (duration - PRELOAD_SECONDS_BEFORE_END) * 1000)
            console.log("[SCHEDULE] Prefetch agendado para daqui a", whenMs, "ms")
            prefetchTimer = setTimeout(prefetchNext, whenMs)
        } catch (err) {
            console.warn("Erro schedulePrefetch", err)
            prefetchTimer = setTimeout(schedulePrefetch, SAFETY_PREFETCH_TIMEOUT_MS)
        }
    }

    // -------------------------
    // Limpa timers e estado relacionado ao vídeo atual
    // -------------------------
    function clearVideoState() {
        if (prefetchTimer) clearTimeout(prefetchTimer)
        if (videoSafetyTimer) clearTimeout(videoSafetyTimer)
        if (forcedIntervalTimer) clearTimeout(forcedIntervalTimer)
        prefetchTimer = videoSafetyTimer = forcedIntervalTimer = null
    }

    // -------------------------
    // Carrega e toca um vídeo (cria player se necessário)
    // -------------------------
    async function playVideoById(videoId, meta = {}) {
        currentVideoId = videoId
        overlay("Tocando: " + (meta.title || videoId))
        debug({ currentVideoId, meta })

        // Determina o tempo inicial
        let startSeconds = 0
        if (meta.durationSeconds >= 1800) {
            // 30 minutos = 1800 segundos
            startSeconds = 300 // começa em 5 minutos
            console.log("[PLAY] Vídeo longo detectado, iniciando em 5 minutos:", startSeconds)
        }

        if (player) {
            try {
                player.loadVideoById({ videoId, startSeconds })
            } catch (err) {
                console.warn("Erro player.loadVideoById, recriando player", err)
                try {
                    player.destroy()
                } catch (e) {}
                player = null
            }
        }

        if (!player) {
            player = new YT.Player("player", {
                height: "100%",
                width: "100%",
                videoId,
                playerVars: {
                    autoplay: 1,
                    controls: 0,
                    modestbranding: 1,
                    rel: 0,
                    playsinline: 1,
                    start: startSeconds, // garante compatibilidade
                },
                events: {
                    onReady: function (e) {
                        e.target.mute()
                        e.target.playVideo()
                        console.log("[PLAYER] Pronto e tocando em", startSeconds, "segundos")
                        schedulePrefetch()
                        startVideoSafetyTimer()
                        startForcedInterval(meta)
                    },
                    onStateChange: function (e) {
                        if (e.data === YT.PlayerState.ENDED) handleVideoEnded()
                        if (e.data === YT.PlayerState.ERROR) handleVideoErrored()
                        if (e.data === YT.PlayerState.PLAYING) schedulePrefetch()
                    },
                    onError: function (e) {
                        console.warn("[PLAYER] Erro detectado", e)
                        handleVideoErrored()
                    },
                },
            })
        } else {
            schedulePrefetch()
            startVideoSafetyTimer()
            startForcedInterval(meta)
        }
    }

    // -------------------------
    // Segurança: timer para evitar travamento indefinido
    // -------------------------
    function startVideoSafetyTimer() {
        if (videoSafetyTimer) clearTimeout(videoSafetyTimer)
        videoSafetyTimer = setTimeout(() => {
            console.warn("[SAFETY] Timeout atingido, pulando vídeo:", currentVideoId)
            forceSkipCurrent()
        }, SAFETY_VIDEO_TIMEOUT_MS)
    }

    // -------------------------
    // Força pular o vídeo atual
    // -------------------------
    async function forceSkipCurrent() {
        console.log("[FORCE] Pulando vídeo atual:", currentVideoId)
        if (currentVideoId) {
            await markPlayed(currentVideoId)
        }
        try {
            if (player && typeof player.stopVideo === "function") player.stopVideo()
        } catch (e) {
            console.warn(e)
        }
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (e) {}
        player = null
        clearVideoState()
        proceedToNext()
    }

    // -------------------------
    // Quando o vídeo termina naturalmente
    // -------------------------
    async function handleVideoEnded() {
        console.log("[ENDED] Vídeo terminou:", currentVideoId)
        await markPlayed(currentVideoId)
        clearVideoState()
        if (upcoming && upcoming.videoId) {
            const next = upcoming
            upcoming = null
            playVideoById(next.videoId, next)
            return
        }
        proceedToNext()
    }

    // -------------------------
    // Quando o player reporta erro
    // -------------------------
    function handleVideoErrored() {
        console.warn("[ERROR] Vídeo erro:", currentVideoId)
        clearVideoState()
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (e) {}
        player = null
        if (upcoming && upcoming.videoId) {
            const next = upcoming
            upcoming = null
            playVideoById(next.videoId, next)
            return
        }
        proceedToNext()
    }

    // -------------------------
    // Busca / usa próximo vídeo
    // -------------------------
    async function proceedToNext() {
        overlay("Buscando próximo vídeo...")
        let next = await fetchNextFromServer()
        if (!next) {
            console.warn("[NEXT] Nenhum próximo vídeo encontrado, retry...")
            setTimeout(proceedToNext, PREFETCH_RETRY_MS)
            return
        }
        playVideoById(next.videoId, next)
    }

    // -------------------------
    // Função de “intervalo forçado” baseada na duração
    // -------------------------
    function startForcedInterval(meta) {
        if (forcedIntervalTimer) clearTimeout(forcedIntervalTimer)
        if (!meta.durationSeconds) return
        let interval = meta.durationSeconds < 600 ? 300000 : 600000 // 5 ou 10 min
        console.log("[FORCED INTERVAL] Intervalo definido para", interval, "ms")
        forcedIntervalTimer = setTimeout(forceSkipCurrent, interval)
    }

    // -------------------------
    // Navegação via teclado
    // -------------------------
    document.addEventListener("keydown", (e) => {
        if (e.code === "ArrowRight") {
            e.preventDefault()
            forceSkipCurrent()
        }
    })

    // -------------------------
    // YouTube API
    // -------------------------
    window.onYouTubeIframeAPIReady = function () {
        console.log("[API] YouTube Iframe API pronta")
        proceedToNext()
    }

    // -------------------------
    // DOMContentLoaded: fullscreen e botões
    // -------------------------
    document.addEventListener("DOMContentLoaded", () => {
        const btnFull = document.getElementById("btn-full")
        const btnNext = document.getElementById("btn-next")
        if (btnFull)
            btnFull.addEventListener("click", () => {
                const el = document.getElementById("player")
                if (el.requestFullscreen) el.requestFullscreen()
                else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
                else if (el.mozRequestFullScreen) el.mozRequestFullScreen()
                else if (el.msRequestFullscreen) el.msRequestFullscreen()
            })
        if (btnNext) btnNext.addEventListener("click", () => forceSkipCurrent())

        const tryFs = () => {
            const el = document.getElementById("player")
            try {
                if (el && el.requestFullscreen) el.requestFullscreen()
            } catch (e) {}
            document.removeEventListener("click", tryFs)
            document.removeEventListener("touchstart", tryFs)
        }
        document.addEventListener("click", tryFs)
        document.addEventListener("touchstart", tryFs)
    })

    window.addEventListener("beforeunload", () => {
        keepRunning = false
        clearVideoState()
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (e) {}
        player = null
    })
})()
