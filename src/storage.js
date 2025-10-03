const fs = require("fs")
const path = require("path")

function readJsonSafe(filePath, defaultValue) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8")
            return defaultValue
        }
        const raw = fs.readFileSync(filePath, "utf8")
        return JSON.parse(raw || "null") || defaultValue
    } catch (err) {
        console.error("Erro lendo JSON", filePath, err)
        return defaultValue
    }
}

function writeJsonSafe(filePath, obj) {
    try {
        const tmp = filePath + ".tmp"
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8")
        fs.renameSync(tmp, filePath)
        return true
    } catch (err) {
        console.error("Erro escrevendo JSON", filePath, err)
        return false
    }
}

module.exports = {
    readJsonSafe,
    writeJsonSafe,
    configPath: path.join(__dirname, "..", "config.json"),
    credentialsPath: path.join(__dirname, "..", "credentials.json"),
    playedPath: path.join(__dirname, "..", "played.json"),
}
