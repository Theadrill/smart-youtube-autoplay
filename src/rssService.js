// src/rssService.js
const fetch = require("node-fetch")
const xml2js = require("xml2js")

async function fetchChannelVideosViaRSS(channelId) {
    try {
        const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
        const res = await fetch(url)
        if (!res.ok) {
            throw new Error("RSS fetch failed: " + res.status)
        }
        const text = await res.text()
        const parsed = await xml2js.parseStringPromise(text, { explicitArray: false })
        let entries = parsed.feed && parsed.feed.entry ? parsed.feed.entry : []
        if (!Array.isArray(entries)) entries = [entries]
        const videos = entries
            .map((e) => {
                const vid = (e["yt:videoId"] || (e.link && e.link.href && e.link.href.split("v=")[1]) || "").toString()
                return {
                    id: vid,
                    title: (e.title || "").toString(),
                    published: e.published ? Date.parse(e.published) : null,
                    durationSeconds: null,
                    viewCount: null,
                    embeddable: null,
                    channelId: e["yt:channelId"] || null,
                }
            })
            .filter((v) => v.id)
        return videos
    } catch (err) {
        console.error("RSS error", err)
        throw err
    }
}

module.exports = {
    fetchChannelVideosViaRSS,
}
