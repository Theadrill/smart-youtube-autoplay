;(function () {
    // -------------------------
    // Configurações locais
    // -------------------------
    const PRELOAD_SECONDS_BEFORE_END = 8
    const SAFETY_PREFETCH_TIMEOUT_MS = 5000
    const SAFETY_VIDEO_TIMEOUT_MS = 1000 * 60 * 5
    const PREFETCH_RETRY_MS = 10000

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
            if (!res.ok) return null
            return await res.json()
        } catch (_) {
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
        } catch (_) {}
    }

    // -------------------------
    // Prefetch do próximo vídeo
    // -------------------------
    async function prefetchNext() {
        const now = Date.now()
        if (now - lastPrefetchAttempt < 2000) return
        lastPrefetchAttempt = now
        if (upcoming) return
        try {
            const next = await fetchNextFromServer()
            if (!next || next.videoId === currentVideoId) {
                setTimeout(() => {
                    if (keepRunning) prefetchNext()
                }, 2000)
                return
            }
            upcoming = next
        } catch (_) {
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
            prefetchTimer = setTimeout(prefetchNext, whenMs)
        } catch (_) {
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

        // Determina o tempo inicial
        let startSeconds = 0
        if (meta.durationSeconds >= 1800) startSeconds = 300

        if (player) {
            try {
                player.loadVideoById({ videoId, startSeconds })
            } catch (_) {
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
                        schedulePrefetch()
                        startVideoSafetyTimer()
                        startForcedInterval(meta)
                    },
                    onStateChange: function (e) {
                        if (e.data === YT.PlayerState.ENDED) handleVideoEnded()
                        if (e.data === YT.PlayerState.ERROR) handleVideoErrored()
                        if (e.data === YT.PlayerState.PLAYING) schedulePrefetch()
                    },
                    onError: function (_) {
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
        videoSafetyTimer = setTimeout(forceSkipCurrent, SAFETY_VIDEO_TIMEOUT_MS)
    }

    // -------------------------
    // Força pular o vídeo atual
    // -------------------------
    async function forceSkipCurrent() {
        if (currentVideoId) await markPlayed(currentVideoId)
        try {
            if (player && typeof player.stopVideo === "function") player.stopVideo()
        } catch (e) {}
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
        let next = await fetchNextFromServer()
        if (!next) {
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
        proceedToNext()
    }

    // -------------------------
    // DOMContentLoaded: fullscreen automático (máximo permitido)
    // -------------------------
    document.addEventListener("DOMContentLoaded", () => {
        const tryFs = () => {
            const el = document.getElementById("player")
            try {
                if (el && el.requestFullscreen) el.requestFullscreen()
                else if (el && el.webkitRequestFullscreen) el.webkitRequestFullscreen()
                else if (el && el.mozRequestFullScreen) el.mozRequestFullScreen()
                else if (el && el.msRequestFullscreen) el.msRequestFullscreen()
            } catch (e) {}
            document.removeEventListener("click", tryFs)
            document.removeEventListener("touchstart", tryFs)
        }
        document.addEventListener("click", tryFs)
        document.addEventListener("touchstart", tryFs)
    })

    // -------------------------
    // Limpeza final ao descarregar a página
    // -------------------------
    window.addEventListener("beforeunload", () => {
        keepRunning = false
        clearVideoState()
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (e) {}
        player = null
    })
})()
