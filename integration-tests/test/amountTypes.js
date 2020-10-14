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

const { assert, should, use } = require('chai')
const chaiAsPromised = require('chai-as-promised')
const RootChain = require('@omisego/omg-js-rootchain')
const ChildChain = require('@omisego/omg-js-childchain')
const Web3 = require('web3')
const erc20abi = require('human-standard-token-abi')

const faucet = require('../helpers/faucet')
const config = require('../test-config')
const rcHelper = require('../helpers/rootChainHelper')

should()
use(chaiAsPromised)

const path = require('path')
const faucetName = path.basename(__filename)

describe('amountTypes.js', function () {
  const web3 = new Web3(new Web3.providers.HttpProvider(config.eth_node))
  const rootChain = new RootChain({ web3, plasmaContractAddress: config.plasmaframework_contract_address })
  const childChain = new ChildChain({ watcherUrl: config.watcher_url, watcherProxyUrl: config.watcher_proxy_url, plasmaContractAddress: config.plasmaframework_contract_address })
  const testErc20Contract = new web3.eth.Contract(erc20abi, config.erc20_contract_address)

  let aliceAccount
  const INTIIAL_ALICE_AMOUNT = web3.utils.toWei('0.5', 'ether')
  const INITIAL_AMOUNT_ERC20 = 3

  before(async function () {
    await faucet.init({ rootChain, childChain, web3, config, faucetName })
  })

  beforeEach(async function () {
    aliceAccount = rcHelper.createAccount(web3)
    await faucet.fundRootchainEth(aliceAccount.address, INTIIAL_ALICE_AMOUNT)
    await faucet.fundRootchainERC20(aliceAccount.address, INITIAL_AMOUNT_ERC20, testErc20Contract)
    await Promise.all([
      rcHelper.waitForEthBalanceEq(web3, aliceAccount.address, INTIIAL_ALICE_AMOUNT),
      rcHelper.waitForERC20BalanceEq(web3, aliceAccount.address, config.erc20_contract_address, INITIAL_AMOUNT_ERC20)
    ])
  })

  afterEach(async function () {
    try {
      await faucet.returnFunds(aliceAccount)
    } catch (err) {
      console.warn(`Error trying to return funds to the faucet: ${err}`)
    }
  })

  it('approveToken() should only accept safe integers and strings and BN', async function () {
    const numberReceipt = await rootChain.approveToken({
      erc20Address: config.erc20_contract_address,
      amount: 10,
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.hasAnyKeys(numberReceipt, ['transactionHash'])

    const stringReceipt = await rootChain.approveToken({
      erc20Address: config.erc20_contract_address,
      amount: '999999999999999999999999',
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.hasAnyKeys(stringReceipt, ['transactionHash'])

    const bnReceipt = await rootChain.approveToken({
      erc20Address: config.erc20_contract_address,
      amount: web3.utils.toBN(1),
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.hasAnyKeys(bnReceipt, ['transactionHash'])

    const unsafeReceipt = rootChain.approveToken({
      erc20Address: config.erc20_contract_address,
      amount: 999999999999999999999999999999999999999999999999999999999999,
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.isRejected(unsafeReceipt)

    const decimalReceipt = rootChain.approveToken({
      erc20Address: config.erc20_contract_address,
      amount: 1.35,
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.isRejected(decimalReceipt)

    const decimalStringReceipt = rootChain.approveToken({
      erc20Address: config.erc20_contract_address,
      amount: '1.23',
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.isRejected(decimalStringReceipt)
  })

  it('deposit() should only accept safe integers, strings, and BN', async function () {
    const numberDeposit = await rootChain.deposit({
      amount: 1,
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.hasAnyKeys(numberDeposit, ['transactionHash'])

    const stringDeposit = await rootChain.deposit({
      amount: '1',
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.hasAnyKeys(stringDeposit, ['transactionHash'])

    const BNDeposit = await rootChain.deposit({
      amount: web3.utils.toBN(1),
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.hasAnyKeys(BNDeposit, ['transactionHash'])

    const unsafeDeposit = rootChain.deposit({
      amount: 99999999999999999999999999999999999,
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.isRejected(unsafeDeposit)

    const decimalDeposit = rootChain.deposit({
      amount: 0.1,
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.isRejected(decimalDeposit)

    const stringDecimalDeposit = rootChain.deposit({
      amount: '1.23',
      txOptions: {
        from: aliceAccount.address,
        privateKey: aliceAccount.privateKey
      }
    })
    assert.isRejected(stringDecimalDeposit)
  })
})
