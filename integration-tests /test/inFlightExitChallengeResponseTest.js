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

const config = require('../test-config')
const rcHelper = require('../helpers/rootChainHelper')
const ccHelper = require('../helpers/childChainHelper')
const faucet = require('../helpers/faucet')
const Web3 = require('web3')
const ChildChain = require('@omisego/omg-js-childchain')
const RootChain = require('@omisego/omg-js-rootchain')
const { transaction } = require('@omisego/omg-js-util')
const numberToBN = require('number-to-bn')
const chai = require('chai')
const assert = chai.assert

const path = require('path')
const faucetName = path.basename(__filename)

describe('inFlightExitChallengeResponseTest.js', function () {
  const web3 = new Web3(new Web3.providers.HttpProvider(config.eth_node))
  const childChain = new ChildChain({ watcherUrl: config.watcher_url, watcherProxyUrl: config.watcher_proxy_url, plasmaContractAddress: config.plasmaframework_contract_address })
  const rootChain = new RootChain({ web3, plasmaContractAddress: config.plasmaframework_contract_address })

  before(async function () {
    await faucet.init({ rootChain, childChain, web3, config, faucetName })
  })

  describe('in-flight transaction challenge response', function () {
    const INTIIAL_ALICE_AMOUNT = web3.utils.toWei('.001', 'ether')
    const INTIIAL_BOB_RC_AMOUNT = web3.utils.toWei('.9', 'ether')
    const TRANSFER_AMOUNT = web3.utils.toWei('0.0002', 'ether')

    let aliceAccount
    let bobAccount
    let carolAccount
    let fundAliceTx

    beforeEach(async function () {
      aliceAccount = rcHelper.createAccount(web3)
      bobAccount = rcHelper.createAccount(web3)
      carolAccount = rcHelper.createAccount(web3)

      await Promise.all([
        // Give some ETH to Alice on the child chain
        faucet.fundChildchain(aliceAccount.address, INTIIAL_ALICE_AMOUNT, transaction.ETH_CURRENCY),
        // Give some ETH to Bob on the root chain
        faucet.fundRootchainEth(bobAccount.address, INTIIAL_BOB_RC_AMOUNT)
      ]).then(([tx]) => (fundAliceTx = tx))

      // Give some ETH to Carol on the root chain
      await faucet.fundRootchainEth(carolAccount.address, INTIIAL_BOB_RC_AMOUNT)

      // Wait for finality
      await Promise.all([
        ccHelper.waitForBalanceEq(childChain, aliceAccount.address, INTIIAL_ALICE_AMOUNT),
        rcHelper.waitForEthBalanceEq(web3, carolAccount.address, INTIIAL_BOB_RC_AMOUNT),
        rcHelper.waitForEthBalanceEq(web3, bobAccount.address, INTIIAL_BOB_RC_AMOUNT)
      ])
    })

    afterEach(async function () {
      try {
        await faucet.returnFunds(aliceAccount)
        await faucet.returnFunds(bobAccount)
        await faucet.returnFunds(carolAccount)
      } catch (err) {
        console.warn(`Error trying to return funds to the faucet: ${err}`)
      }
    })

    it('should respond to an invalid IFE challenge', async function () {
      // Alice creates a transaction to send funds to Bob
      const bobSpentOnGas = numberToBN(0)
      const bobTx = await ccHelper.createTx(
        childChain,
        aliceAccount.address,
        bobAccount.address,
        TRANSFER_AMOUNT,
        transaction.ETH_CURRENCY,
        aliceAccount.privateKey,
        rootChain.plasmaContractAddress
      )

      // Bob doesn't see the transaction get put into a block. He assumes that the operator
      // is witholding, so he attempts to exit his spent utxo as an in-flight exit

      // Get the exit data
      const exitData = await childChain.inFlightExitGetData(bobTx)
      assert.containsAllKeys(exitData, ['in_flight_tx', 'in_flight_tx_sigs', 'input_txs', 'input_txs_inclusion_proofs', 'input_utxos_pos'])

      // Starts the in-flight exit
      const ifeExitReceipt = await rootChain.startInFlightExit({
        inFlightTx: exitData.in_flight_tx,
        inputTxs: exitData.input_txs,
        inputUtxosPos: exitData.input_utxos_pos,
        inputTxsInclusionProofs: exitData.input_txs_inclusion_proofs,
        inFlightTxSigs: exitData.in_flight_tx_sigs,
        txOptions: {
          privateKey: bobAccount.privateKey,
          from: bobAccount.address
        }
      })
      console.log(`Bob called RootChain.startInFlightExit(): txhash = ${ifeExitReceipt.transactionHash}`)

      // Keep track of how much Bob spends on gas
      bobSpentOnGas.iadd(await rcHelper.spentOnGas(web3, ifeExitReceipt))
      const decodedTx = transaction.decodeTxBytes(bobTx)
      const outputIndex = decodedTx.outputs.findIndex(e => e.outputGuard === bobAccount.address)

      // Bob piggybacks his output on the in-flight exit
      let receipt = await rootChain.piggybackInFlightExitOnOutput({
        inFlightTx: exitData.in_flight_tx,
        outputIndex: outputIndex,
        txOptions: {
          privateKey: bobAccount.privateKey,
          from: bobAccount.address
        }
      })

      console.log(`Bob called RootChain.piggybackInFlightExit() : txhash = ${receipt.transactionHash}`)
      bobSpentOnGas.iadd(await rcHelper.spentOnGas(web3, receipt))

      // Meanwhile, Alice also sends funds to Carol (double spend). This transaction doesn't get put into a block either.
      const carolTx = await ccHelper.createTx(
        childChain,
        aliceAccount.address,
        carolAccount.address,
        TRANSFER_AMOUNT,
        transaction.ETH_CURRENCY,
        aliceAccount.privateKey,
        rootChain.plasmaContractAddress
      )

      // Bob's transaction eventually does get put into a block
      await childChain.submitTransaction(bobTx)
      await ccHelper.waitForBalanceEq(childChain, bobAccount.address, TRANSFER_AMOUNT)

      // Carol sees that Bob is trying to exit the same input that Alice sent to her.
      const carolTxDecoded = transaction.decodeTxBytes(carolTx)
      const cInput = carolTxDecoded.inputs[0]
      const inflightExit = await ccHelper.waitForEvent(
        childChain,
        'in_flight_exits',
        e => {
          const decoded = transaction.decodeTxBytes(e.txbytes)
          return decoded.inputs.find(input =>
            input.blknum === cInput.blknum &&
            input.txindex === cInput.txindex &&
            input.oindex === cInput.oindex
          )
        }
      )

      // Carol's tx was not put into a block, but it can still be used to challenge Bob's IFE as non-canonical
      const utxoPosOutput = transaction.encodeUtxoPos({
        blknum: fundAliceTx.result.blknum,
        txindex: fundAliceTx.result.txindex,
        oindex: 0
      }).toNumber()

      const unsignInput = transaction.encode(transaction.decodeTxBytes(fundAliceTx.txbytes), { signed: false })
      const unsignCarolTx = transaction.encode(carolTxDecoded, { signed: false })
      receipt = await rootChain.challengeInFlightExitNotCanonical({
        inputTx: unsignInput,
        inputUtxoPos: utxoPosOutput,
        inFlightTx: inflightExit.txbytes,
        inFlightTxInputIndex: 0,
        competingTx: unsignCarolTx,
        competingTxInputIndex: 0,
        competingTxPos: '0x',
        competingTxInclusionProof: '0x',
        competingTxWitness: carolTxDecoded.sigs[0],
        txOptions: {
          privateKey: carolAccount.privateKey,
          from: carolAccount.address
        }
      })

      // Bob sees the invalid challenge to his IFE
      const invalidChallenge = await ccHelper.waitForEvent(
        childChain,
        'byzantine_events',
        e => e.event === 'invalid_ife_challenge' && e.details.txbytes === exitData.in_flight_tx
      )

      // Bob gets the inclusion proof of his transaction
      const proof = await childChain.inFlightExitProveCanonical(invalidChallenge.details.txbytes)

      // Bob responds to the challenge
      receipt = await rootChain.respondToNonCanonicalChallenge({
        inFlightTx: proof.in_flight_txbytes,
        inFlightTxPos: proof.in_flight_tx_pos,
        inFlightTxInclusionProof: proof.in_flight_proof,
        txOptions: {
          privateKey: bobAccount.privateKey,
          from: bobAccount.address
        }
      })
      console.log(`Bob called RootChain.respondToNonCanonicalChallenge() txhash = ${receipt.transactionHash}`)
      bobSpentOnGas.iadd(await rcHelper.spentOnGas(web3, receipt))

      // Wait for challenge period
      const { msUntilFinalization } = await rootChain.getExitTime({
        exitRequestBlockNumber: ifeExitReceipt.blockNumber,
        submissionBlockNumber: fundAliceTx.result.blknum
      })
      console.log(`Waiting for challenge period... ${msUntilFinalization / 60000} minutes`)
      await rcHelper.sleep(msUntilFinalization)

      // Call processExits.
      receipt = await rootChain.processExits({
        token: transaction.ETH_CURRENCY,
        exitId: 0,
        maxExitsToProcess: 10,
        txOptions: {
          privateKey: bobAccount.privateKey,
          from: bobAccount.address,
          gas: 6000000
        }
      })
      if (receipt) {
        console.log(`Bob called RootChain.processExits() after challenge period: txhash = ${receipt.transactionHash}`)
        bobSpentOnGas.iadd(await rcHelper.spentOnGas(web3, receipt))
        await rcHelper.awaitTx(web3, receipt.transactionHash)
      }

      // Get Bob's ETH balance
      const bobEthBalance = await web3.eth.getBalance(bobAccount.address)
      // Bob's IFE was successful, so expect his balance to be
      // INTIIAL_BOB_AMOUNT + TRANSFER_AMOUNT - gas spent
      const expected = web3.utils.toBN(INTIIAL_BOB_RC_AMOUNT)
        .add(web3.utils.toBN(TRANSFER_AMOUNT))
        .sub(bobSpentOnGas)
      assert.equal(bobEthBalance.toString(), expected.toString())
    })
  })
})
