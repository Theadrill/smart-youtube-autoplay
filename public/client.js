// public/client.js
// Versão com prefetch do próximo vídeo para reduzir gap entre vídeos.
// Usa endpoints: GET /api/next e POST /api/played
// Vanilla JS, sem dependências externas.

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

        definirInterval(text)
    }

    // -------------------------
    // Estado
    // -------------------------
    let player = null
    let currentVideoId = null
    let upcoming = null
    let prefetchTimer = null
    let videoSafetyTimer = null
    let isLoading = false
    let keepRunning = true
    let lastPrefetchAttempt = 0

    // -------------------------
    // Chamada ao servidor
    // -------------------------
    async function fetchNextFromServer() {
        try {
            const res = await fetch("/api/next")
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                overlay("Nenhum vídeo: " + (body.error || res.status))
                return null
            }
            const data = await res.json()
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
        try {
            const next = await fetchNextFromServer()
            if (!next) {
                setTimeout(() => {
                    if (keepRunning) prefetchNext()
                }, PREFETCH_RETRY_MS)
                return
            }
            if (next.videoId === currentVideoId) {
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
                prefetchTimer = setTimeout(() => {
                    schedulePrefetch()
                }, 2000)
                return
            }
            const duration = player.getDuration()
            if (!duration || isNaN(duration) || duration <= PRELOAD_SECONDS_BEFORE_END + 1) {
                prefetchTimer = setTimeout(() => {
                    prefetchNext()
                }, 500)
                return
            }
            const whenMs = Math.max(200, (duration - PRELOAD_SECONDS_BEFORE_END) * 1000)
            prefetchTimer = setTimeout(() => {
                prefetchNext()
            }, whenMs)
        } catch (err) {
            console.warn("Erro schedulePrefetch", err)
            prefetchTimer = setTimeout(() => {
                schedulePrefetch()
            }, SAFETY_PREFETCH_TIMEOUT_MS)
        }
    }

    // -------------------------
    // Limpa timers e estado relacionado ao vídeo atual
    // -------------------------
    function clearVideoState() {
        if (prefetchTimer) {
            clearTimeout(prefetchTimer)
            prefetchTimer = null
        }
        if (videoSafetyTimer) {
            clearTimeout(videoSafetyTimer)
            videoSafetyTimer = null
        }
    }

    // -------------------------
    // Carrega e toca um vídeo (cria player se necessário)
    // -------------------------
    async function playVideoById(videoId, meta = {}) {
        currentVideoId = videoId
        overlay("Tocando: " + (meta.title || videoId))
        debug({ currentVideoId, meta })

        if (player) {
            try {
                isLoading = true
                player.loadVideoById({ videoId: videoId, startSeconds: 0 })
            } catch (err) {
                console.warn("Erro player.loadVideoById, recriando player", err)
                try {
                    player.destroy()
                } catch (e) {}
                player = null
            } finally {
                isLoading = false
            }
        }

        if (!player) {
            isLoading = true
            player = new YT.Player("player", {
                height: "100%",
                width: "100%",
                videoId: videoId,
                playerVars: {
                    autoplay: 1,
                    controls: 0,
                    modestbranding: 1,
                    rel: 0,
                    playsinline: 1,
                },
                events: {
                    onReady: function (e) {
                        try {
                            e.target.mute()
                            e.target.playVideo()
                        } catch (err) {
                            console.warn("onReady error", err)
                        }
                        schedulePrefetch()
                        startVideoSafetyTimer()
                    },
                    onStateChange: function (e) {
                        if (e.data === YT.PlayerState.ENDED) {
                            handleVideoEnded()
                        }
                        if (e.data === YT.PlayerState.ERROR) {
                            console.warn("Player reported ERROR state. Pulando para o próximo.")
                            handleVideoErrored()
                        }
                        if (e.data === YT.PlayerState.PLAYING) {
                            schedulePrefetch()
                        }
                    },
                    // ADICIONADO: trata toda situação de vídeo bloqueado/indisponível
                    onError: function (e) {
                        console.warn("onError disparado pelo player (vídeo indisponível ou bloqueado)", e)
                        handleVideoErrored()
                    },
                },
            })
            isLoading = false
        } else {
            schedulePrefetch()
            startVideoSafetyTimer()
        }
    }

    // -------------------------
    // Segurança: timer para evitar travamento indefinido
    // -------------------------
    function startVideoSafetyTimer() {
        if (videoSafetyTimer) clearTimeout(videoSafetyTimer)
        videoSafetyTimer = setTimeout(() => {
            console.warn("Safety timeout atingido para vídeo", currentVideoId, ". Forçando próximo.")
            forceSkipCurrent()
        }, SAFETY_VIDEO_TIMEOUT_MS)
    }

    // -------------------------
    // Força pular o vídeo atual
    // -------------------------
    function forceSkipCurrent() {
        try {
            if (player && typeof player.stopVideo === "function") player.stopVideo()
        } catch (err) {
            console.warn("Erro stopVideo", err)
        }
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (err) {}
        player = null
        clearVideoState()
        proceedToNext()
    }

    // -------------------------
    // Quando o vídeo termina naturalmente
    // -------------------------
    async function handleVideoEnded() {
        try {
            await markPlayed(currentVideoId)
        } catch (e) {
            console.warn(e)
        }
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
    // Quando o player reporta erro (ex.: embed blocked)
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
    // Busca / usa próximo vídeo quando não há upcoming
    // -------------------------
    async function proceedToNext() {
        overlay("Buscando próximo vídeo...")
        let next = await fetchNextFromServer()
        if (!next) {
            setTimeout(async () => {
                next = await fetchNextFromServer()
                if (!next) {
                    overlay("Falha ao buscar próximo. Tentando novamente...")
                    setTimeout(() => {
                        if (keepRunning) proceedToNext()
                    }, PREFETCH_RETRY_MS)
                    return
                }
                playVideoById(next.videoId, next)
            }, PREFETCH_RETRY_MS)
            return
        }
        playVideoById(next.videoId, next)
    }

    window.onYouTubeIframeAPIReady = function () {
        console.log("YouTube Iframe API pronta")
        proceedToNext()
    }

    document.addEventListener("DOMContentLoaded", () => {
        const btnFull = document.getElementById("btn-full")
        const btnNext = document.getElementById("btn-next")
        if (btnFull)
            btnFull.addEventListener("click", () => {
                const el = document.getElementById("player")
                if (!el) return
                if (el.requestFullscreen) el.requestFullscreen()
                else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
                else if (el.mozRequestFullScreen) el.mozRequestFullScreen()
                else if (el.msRequestFullscreen) el.msRequestFullscreen()
            })
        if (btnNext)
            btnNext.addEventListener("click", () => {
                forceSkipCurrent()
            })

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

    // -------------------------
    // Navegação via teclado
    // -------------------------
    document.addEventListener("keydown", (e) => {
        if (e.code === "ArrowRight") {
            e.preventDefault() // impede ação do player YouTube
            forceSkipCurrent() // força carregar próximo vídeo
        } else if (e.code === "ArrowLeft") {
            e.preventDefault()
            // opcional: voltar ao vídeo anterior, se implementar histórico
        }
    })

    function definirInterval(text) {
        console.log(text.meta.durationSeconds)

        let interval = 300000

        if (text.meta.durationSeconds < 600) {
            interval = 300000
        } else {
            interval = 600000
        }

        setInterval(() => {
            forceSkipCurrent()
        }, interval)

        console.log(interval)
    }
})()
