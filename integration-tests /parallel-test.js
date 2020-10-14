/*
Copyright 2019 OmiseGO Pte Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License. */

const RootChain = require('@omisego/omg-js-rootchain')
const ChildChain = require('@omisego/omg-js-childchain')
const Web3 = require('web3')
const fs = require('fs')
const os = require('os')

const faucet = require('./helpers/faucet')
const config = require('./test-config')

const MochaParallel = require('mocha-parallel-tests').default
const mochaParallel = new MochaParallel({
  enableTimeouts: false,
  slow: 0,
  useColors: true,
  fullStackTrace: true,
  reporter: 'list'
})

const allFiles = fs.readdirSync(`${__dirname}/test/`)
// tests that dont work well in parallel environment
const skippedTests = [
  'getExitQueueTest.js'
]
const files = allFiles.filter(i => !skippedTests.includes(i))

for (const test of files) {
  mochaParallel.addFile(`${__dirname}/test/${test}`)
}

async function setup () {
  const web3 = new Web3(new Web3.providers.HttpProvider(config.eth_node))
  const rootChain = new RootChain({ web3, plasmaContractAddress: config.plasmaframework_contract_address })
  const childChain = new ChildChain({ watcherUrl: config.watcher_url, watcherProxyUrl: config.watcher_proxy_url, plasmaContractAddress: config.plasmaframework_contract_address })

  const start = new Date()
  for (const faucetName of files) {
    await faucet.init({ rootChain, childChain, web3, config, faucetName })
    console.log(`💰 Test faucet funded for ${faucetName}`)
    console.log('\n')
  }
  const end = new Date()
  console.log(`⏳ Total funding time: ${(end - start) / 60000} min`)
}

async function runner () {
  await setup()

  const cores = os.cpus().length
  console.log(`🚀 Running ${files.length} test files in parallel`)
  console.log(`💻 ${cores} CPI cores available, will run ${cores} tests at a time`)
  mochaParallel.run(fails => {
    if (fails > 0) {
      throw Error(`${fails} failures in test run`)
    }
  })
}

runner()
