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
  limitations under the License.
*/

const BigNumber = require('bn.js')
const Web3 = require('web3')
const RootChain = require('../packages/omg-js-rootchain/src/rootchain')
const ChildChain = require('../packages/omg-js-childchain/src/childchain')
const { transaction, hexPrefix, waitForRootchainTransaction } = require('../packages/omg-js-util/src')
const getFlags = require('./parse-args')
const config = require('./config.js')
const wait = require('./wait.js')

const web3 = new Web3(new Web3.providers.HttpProvider(config.eth_node), null, { transactionConfirmationBlocks: 1 })
const rootChain = new RootChain({ web3, plasmaContractAddress: config.plasmaframework_contract_address })
const rootChainPlasmaContractAddress = config.plasmaframework_contract_address
const childChain = new ChildChain({ watcherUrl: config.watcher_url, watcherProxyUrl: config.watcher_proxy_url, plasmaContractAddress: config.plasmaframework_contract_address })

async function inFlightExitEth () {
  try {
    const { from, to, amount } = getFlags('from', 'to', 'amount')
    const fromAddress = config[`${from}_eth_address`]
    const fromPk = config[`${from}_eth_address_private_key`]
    const toAddress = config[`${to}_eth_address`]
    const toPk = config[`${to}_eth_address_private_key`]
    const transferAmount = new BigNumber(web3.utils.toWei(amount, 'ether'))

    const rootchainBalance = await web3.eth.getBalance(toAddress)
    const etherBalance = web3.utils.fromWei(String(rootchainBalance), 'ether')
    if (etherBalance < 0.001) {
      console.log('The --to address doesnt have enough ETH on the rootchain to start an exit')
      return
    }

    const payments = [{
      owner: toAddress,
      currency: transaction.ETH_CURRENCY,
      amount: transferAmount
    }]
    const fee = { currency: transaction.ETH_CURRENCY }
    const createdTxn = await childChain.createTransaction({
      owner: fromAddress,
      payments,
      fee
    })
    console.log(`Created a childchain transaction of ${web3.utils.fromWei(payments[0].amount.toString(), 'ether')} ETH`)

    // type/sign/build/submit
    const typedData = transaction.getTypedData(createdTxn.transactions[0], rootChainPlasmaContractAddress)
    const signatures = childChain.signTransaction(typedData, [fromPk])
    const signedTxn = childChain.buildSignedTransaction(typedData, signatures)
    console.log('Transaction created but not submitted')

    // Bob hasn't seen the transaction get put into a block and he wants to exit his output.
    // check if queue exists for this token
    const hasToken = await rootChain.hasToken(transaction.ETH_CURRENCY)
    if (!hasToken) {
      console.log(`Adding a ${transaction.ETH_CURRENCY} exit queue`)
      await rootChain.addToken({
        token: transaction.ETH_CURRENCY,
        txOptions: { from: toAddress, privateKey: toPk }
      })
    }

    // start an in-flight exit
    const exitData = await childChain.inFlightExitGetData(hexPrefix(signedTxn))
    const exitReceipt = await rootChain.startInFlightExit({
      inFlightTx: exitData.in_flight_tx,
      inputTxs: exitData.input_txs,
      inputUtxosPos: exitData.input_utxos_pos,
      inputTxsInclusionProofs: exitData.input_txs_inclusion_proofs,
      inFlightTxSigs: exitData.in_flight_tx_sigs,
      txOptions: {
        privateKey: toPk,
        from: toAddress
      }
    })
    console.log('--to address started an inflight exit: ', exitReceipt.transactionHash)

    const exitId = await rootChain.getInFlightExitId({ txBytes: exitData.in_flight_tx })
    console.log('Exit id: ', exitId)

    // Decode the transaction to get the index of Bob's output
    const outputIndex = createdTxn.transactions[0].outputs.findIndex(
      e => e.owner.toLowerCase() === toAddress.toLowerCase()
    )

    // Bob needs to piggyback his output on the in-flight exit
    await rootChain.piggybackInFlightExitOnOutput({
      inFlightTx: exitData.in_flight_tx,
      outputIndex: outputIndex,
      txOptions: {
        privateKey: toPk,
        from: toAddress
      }
    })
    console.log('Output piggybacked')

    // wait for challenge period to complete
    await wait.waitForChallengePeriodToEnd(rootChain)

    // call processExits() after challenge period is over
    const processExitsPostChallengeReceipt = await rootChain.processExits({
      token: transaction.ETH_CURRENCY,
      exitId: 0,
      maxExitsToProcess: 20,
      txOptions: { privateKey: toPk, from: toAddress }
    })

    await waitForRootchainTransaction({
      web3,
      transactionHash: processExitsPostChallengeReceipt.transactionHash,
      checkIntervalMs: config.millis_to_wait_for_next_block,
      blocksToWait: config.blocks_to_wait_for_txn,
      onCountdown: (remaining) => console.log(`${remaining} blocks remaining before confirmation`)
    })
    console.log('Exits processed')
  } catch (error) {
    console.log('Error: ', error.message)
  }
}

inFlightExitEth()
