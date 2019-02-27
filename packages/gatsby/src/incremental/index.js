const apiRunner = require(`./api-runner-node`)

async function sourceNodes() {
  await apiRunner(`sourceNodes`, {
    traceId: `initial-sourceNodes`,
    waitForCascadingActions: true,
  })
}

function build() {}
