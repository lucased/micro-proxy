const micro = require('micro')
const { resolve, parse, URL } = require('url')
const fetch = require('node-fetch')
const lintRules = require('./lib/lint-rules')
const WebSocket = require('ws')

module.exports = (rules) => {
  const lintedRules = lintRules(rules).map(({pathname, pathnameRe, method, dest, headers}) => {
    const methods = method ? method.reduce((final, c) => {
      final[c.toLowerCase()] = true
      return final
    }, {}) : null

    return {
      pathname,
      pathnameRegexp: new RegExp(pathnameRe || pathname || '.*'),
      dest,
      methods,
      headers
    }
  })

  const getDest = (req) => {
    const newReq = {...req, url: req.url.split('?')[0]}
    for (const { pathnameRegexp, methods, dest } of lintedRules) {
      if (pathnameRegexp.test(newReq.url) && (!methods || methods[newReq.method.toLowerCase()])) {
        return dest
      }
    }
  }

  const getHeaders = (req) => {
    const newReq = {...req, url: req.url.split('?')[0]}
    for (const { pathnameRegexp, methods, headers } of lintedRules) {
      if (pathnameRegexp.test(newReq.url) && (!methods || methods[newReq.method.toLowerCase()])) {
        return headers
      }
    }
  }

  const server = micro(async (req, res) => {
    try {
      const dest = getDest(req)
      const headers = getHeaders(req)

      if (!dest) {
        res.writeHead(404)
        res.end('404 - Not Found')
        return
      }

      await proxyRequest(req, res, dest, headers)
    } catch (err) {
      console.error(err.stack)
      res.end()
    }
  })

  const wss = new WebSocket.Server({ server })
  wss.on('connection', (ws, req) => {
    const dest = getDest(req)

    if (!dest) {
      ws.close()
      return
    }

    proxyWs(ws, req, dest)
  })

  return server
}

function proxyWs (ws, req, dest) {
  const destUrlObject = parse(dest)
  const newUrl = `ws://${destUrlObject.host}${req.url}`

  const destWs = new WebSocket(newUrl)

  // util functions
  const incomingHandler = (message) => {
    destWs.send(message)
  }

  const outgoingHandler = (message) => {
    ws.send(message)
  }

  const onError = (err) => {
    console.error(`Error on proxying url: ${newUrl}`)
    console.error(err.stack)
  }

  const removeListeners = () => {
    ws.removeListener('message', incomingHandler)
    destWs.removeListener('message', outgoingHandler)
  }

  // events handling
  destWs.on('open', () => {
    ws.addListener('message', incomingHandler)
    destWs.addListener('message', outgoingHandler)
  })

  ws.on('close', () => {
    destWs.close()
    removeListeners()
  })

  destWs.on('close', () => {
    ws.close()
    removeListeners()
  })

  ws.on('error', onError)
  destWs.on('error', onError)
}

async function proxyRequest (req, res, dest, reqHeaders) {
  const newUrl = resolve(dest, req.url)
  const url = new URL(dest)
  const proxyRes = await fetch(newUrl, {
    method: req.method,
    headers: Object.assign({}, req.headers, { host: url.host }),
    body: req,
    compress: false
  })

  // Forward status code
  res.statusCode = proxyRes.status

  // Forward headers
  const headers = Object.assign({}, proxyRes.headers.raw(), reqHeaders)
  for (const key of Object.keys(headers)) {
    res.setHeader(key, headers[key])
  }

  // Stream the proxy response
  proxyRes.body.pipe(res)
  proxyRes.body.on('error', (err) => {
    console.error(`Error on proxying url: ${newUrl}`)
    console.error(err.stack)
    res.end()
  })

  req.on('abort', () => {
    proxyRes.body.destroy()
  })
}
