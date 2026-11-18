const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    '/api/health': () => Response.json({ status: 'ok' }),
  },
  fetch() {
    return Response.json({ error: 'Not found' }, { status: 404 })
  },
})

console.log(`api listening on ${server.url}`)
