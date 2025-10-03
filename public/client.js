// public/client.js
// Versão com prefetch do próximo vídeo para reduzir gap entre vídeos.
// Usa endpoints: GET /api/next e POST /api/played
// Vanilla JS, sem dependências externas.

;(function () {
    // -------------------------
    // Configurações locais
    // -------------------------
    const PRELOAD_SECONDS_BEFORE_END = 8 // buscar próximo com X segundos de antecedência
    const SAFETY_PREFETCH_TIMEOUT_MS = 5000 // se não obtiver duração, prefetch após esse tempo
    const SAFETY_VIDEO_TIMEOUT_MS = 1000 * 60 * 5 // timeout de segurança: 5 minutos por vídeo
    const PREFETCH_RETRY_MS = 10000 // se prefetch falhar, tentar novamente depois disso

    // -------------------------
    // Helpers de UI (pegados no DOM após carregamento)
    // -------------------------
    const overlayEl = document.getElementById("overlay")
    const debugEl = document.getElementById("debug")
    function overlay(text) {
        if (overlayEl) overlayEl.innerText = text
    }
    function debug(text) {
        if (debugEl) debugEl.innerText = typeof text === "string" ? text : JSON.stringify(text, null, 2)
    }

    // -------------------------
    // Estado
    // -------------------------
    let player = null // instância YT.Player
    let currentVideoId = null // id do vídeo atualmente tocando
    let upcoming = null // { videoId, ... } pré-carregado (prefetch)
    let prefetchTimer = null // timeout id para agendamento do prefetch
    let videoSafetyTimer = null // timeout que evita travar indefinidamente
    let isLoading = false // flag para evitar chamadas concorrentes
    let keepRunning = true // controle principal (pode ser usado para parar o loop)
    let lastPrefetchAttempt = 0

    // -------------------------
    // Chamada ao servidor: pega próximo vídeo elegível
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
    // Prefetch: busca e armazena o próximo vídeo sem interromper a reprodução atual
    // -------------------------
    async function prefetchNext() {
        // evita prefetchs repetidos em curto tempo
        const now = Date.now()
        if (now - lastPrefetchAttempt < 2000) return // debounce
        lastPrefetchAttempt = now

        // já tem prefetch pendente?
        if (upcoming) return

        overlay("Pré-carregando próximo vídeo...")
        try {
            const next = await fetchNextFromServer()
            if (!next) {
                // schedule retry
                setTimeout(() => {
                    if (keepRunning) prefetchNext()
                }, PREFETCH_RETRY_MS)
                return
            }
            // se o próximo for exatamente o mesmo do atual, ignoramos e tentamos buscar outro
            if (next.videoId === currentVideoId) {
                // tentar novamente em alguns segundos
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
    // Agendador de prefetch baseado na duração do vídeo atual
    // -------------------------
    function schedulePrefetch() {
        // limpa timer anterior
        if (prefetchTimer) {
            clearTimeout(prefetchTimer)
            prefetchTimer = null
        }

        // se já temos upcoming, nada a fazer
        if (upcoming) return

        // tenta obter duração do vídeo
        try {
            if (!player || typeof player.getDuration !== "function") {
                // se não tiver player pronto, tenta em curto tempo
                prefetchTimer = setTimeout(() => {
                    schedulePrefetch()
                }, 2000)
                return
            }
            const duration = player.getDuration() // em segundos
            // se duração inválida/zero: fallback para tentar em SAFETY_PREFETCH_TIMEOUT_MS
            if (!duration || isNaN(duration) || duration <= PRELOAD_SECONDS_BEFORE_END + 1) {
                // vídeo muito curto ou sem duração conhecida -> buscar logo
                prefetchTimer = setTimeout(() => {
                    prefetchNext()
                }, 500) // quase imediato
                return
            }
            // caso normal: agendar prefetch quando faltar PRELOAD_SECONDS_BEFORE_END segundos
            const whenMs = Math.max(200, (duration - PRELOAD_SECONDS_BEFORE_END) * 1000)
            prefetchTimer = setTimeout(() => {
                prefetchNext()
            }, whenMs)
        } catch (err) {
            console.warn("Erro schedulePrefetch", err)
            // fallback: tentar novamente em 5s
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
        // NOT clearing upcoming here: we might want to keep preloaded next
    }

    // -------------------------
    // Carrega e toca um vídeo (cria player se necessário)
    // -------------------------
    async function playVideoById(videoId, meta = {}) {
        currentVideoId = videoId
        overlay("Tocando: " + (meta.title || videoId))
        debug({ currentVideoId, meta })

        // ensure player exists
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
            // criar novo player
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
                            // MUTE para permitir autoplay em muitos navegadores. Se quiser som, operador clica para ativar.
                            e.target.mute()
                            e.target.playVideo()
                        } catch (err) {
                            console.warn("onReady error", err)
                        }
                        // após começar, agende prefetch
                        schedulePrefetch()
                        // safety timer: evita travamento eterno (ex: erro no player)
                        startVideoSafetyTimer()
                    },
                    onStateChange: function (e) {
                        // Estado ENDED -> vídeo terminou naturalmente
                        if (e.data === YT.PlayerState.ENDED) {
                            handleVideoEnded()
                        }
                        // Erro do player (ex: embed blocked -> 101/150 internamente), tratar como pular
                        if (e.data === YT.PlayerState.ERROR) {
                            console.warn("Player reported ERROR state. Pulando para o próximo.")
                            handleVideoErrored()
                        }
                        // Se começou a tocar (PLAYING) podemos garantir prefetch agendado
                        if (e.data === YT.PlayerState.PLAYING) {
                            schedulePrefetch()
                        }
                    },
                },
            })
            isLoading = false
        } else {
            // se player já existe e só carregamos videoId, garantir agendamento
            schedulePrefetch()
            startVideoSafetyTimer()
        }
    }

    // -------------------------
    // Segurança: timer para evitar travamento indefinido num vídeo
    // -------------------------
    function startVideoSafetyTimer() {
        if (videoSafetyTimer) clearTimeout(videoSafetyTimer)
        videoSafetyTimer = setTimeout(() => {
            console.warn("Safety timeout atingido para vídeo", currentVideoId, ". Forçando próximo.")
            // forçar pular
            forceSkipCurrent()
        }, SAFETY_VIDEO_TIMEOUT_MS)
    }

    // -------------------------
    // Força pular o vídeo atual (usado em safety timeout ou quando operador clica pular)
    // -------------------------
    function forceSkipCurrent() {
        try {
            if (player && typeof player.stopVideo === "function") player.stopVideo()
        } catch (err) {
            console.warn("Erro stopVideo", err)
        }
        // destruir player para forçar reload no próximo
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (err) {}
        player = null
        // limpar estado e proceder para próximo
        clearVideoState()
        // se já existe upcoming, usá-lo; caso contrário, buscar do servidor
        proceedToNext()
    }

    // -------------------------
    // Quando o vídeo termina naturalmente
    // -------------------------
    async function handleVideoEnded() {
        // marca como played
        try {
            await markPlayed(currentVideoId)
        } catch (e) {
            console.warn(e)
        }
        // limpar estados do vídeo
        clearVideoState()
        // se existe upcoming pré-carregado, tocar imediatamente
        if (upcoming && upcoming.videoId) {
            const next = upcoming
            upcoming = null // consume
            // tocar next imediatamente (sem esperar fetch)
            playVideoById(next.videoId, next)
            return
        }
        // senão, buscar e tocar
        proceedToNext()
    }

    // -------------------------
    // Quando o player reporta erro (ex.: embed blocked)
    // -------------------------
    function handleVideoErrored() {
        // Não marcamos como played: queremos que não seja contado como reproduzido.
        clearVideoState()
        // destruir e tentar próximo
        try {
            if (player && typeof player.destroy === "function") player.destroy()
        } catch (e) {}
        player = null
        // Se já temos um upcoming, usá-lo – senão buscar novo
        if (upcoming && upcoming.videoId) {
            const next = upcoming
            upcoming = null
            playVideoById(next.videoId, next)
            return
        }
        // caso contrário, buscar no servidor
        proceedToNext()
    }

    // -------------------------
    // Busca / usa próximo vídeo quando não há upcoming
    // -------------------------
    async function proceedToNext() {
        overlay("Buscando próximo vídeo...")
        // tenta buscar; se falhar, tentar novamente com backoff
        let next = await fetchNextFromServer()
        if (!next) {
            // aguardar um pouco e tentar novamente
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

    // -------------------------
    // Inicialização: esperar YT Iframe API e iniciar loop
    // -------------------------
    window.onYouTubeIframeAPIReady = function () {
        console.log("YouTube Iframe API pronta")
        // iniciar o primeiro fetch e tocar
        proceedToNext()
    }

    // -------------------------
    // Botões de controle (opcional, escondidos por default)
    // -------------------------
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
                // operador pediu pular
                forceSkipCurrent()
            })

        // solicita fullscreen numa interação do usuário (ajuda em alguns dispositivos a permitir som/autoplay)
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

    // -------------------------
    // Antes de sair da página, limpar timers/objetos
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
