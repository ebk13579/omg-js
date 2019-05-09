/*
Copyright 2018 OmiseGO Pte Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License. */

const rpcApi = require('./rpc/rpcApi')
const rlp = require('rlp')
const { InvalidArgumentError, transaction, sign } = require('@omisego/omg-js-util')
global.Buffer = global.Buffer || require('buffer').Buffer

class ChildChain {
  /**
  * Creates a ChildChain object
  *
  *@param {string} watcherUrl the url of the watcher server
  *@param {string} childChainUrl the url of the childchain server
  *@return {Object} ChildChain Object
  *
  */
  constructor (watcherUrl, childChainUrl) {
    this.watcherUrl = watcherUrl
    this.childChainUrl = childChainUrl
  }

  /**
   * Gets the UTXOs of an address
   *
   * @method getUtxos
   * @param {string} address
   * @return {Array} array of UTXOs
   */
  async getUtxos (address) {
    validateAddress(address)
    return rpcApi.post(`${this.watcherUrl}/account.get_utxos`, { address })
  }

  /**
   * Get the balance of an address
   *
   * @method getBalance
   * @param {string} address
   * @return {Array} array of balances (one per currency)
   */
  async getBalance (address) {
    validateAddress(address)
    return rpcApi.post(`${this.watcherUrl}/account.get_balance`, { address })
  }

  /**
   * Get a transaction
   *
   * @method getTransaction
   * @param {object} id The hash of the transaction to get
   * @return {Array} array of transactions
   */
  async getTransaction (id) {
    return rpcApi.post(`${this.watcherUrl}/transaction.get`, { id })
  }

  /**
   * Get transactions
   *
   * @method getTransactions
   * @param {object} filters Filter the results by `address`, `blknum` and `limit`
   * @return {Array} array of transactions
   */
  async getTransactions (filters) {
    return rpcApi.post(`${this.watcherUrl}/transaction.all`, filters)
  }

  /**
   * Get the exit data for a UTXO
   *
   * @method getExitData
   * @param {Object} utxo
   * @return {string} exit data for the UTXO
   */
  async getExitData (utxo) {
    // Calculate the utxoPos
    const utxoPos = transaction.encodeUtxoPos(utxo)
    return rpcApi.post(`${this.watcherUrl}/utxo.get_exit_data`, { utxo_pos: Number(utxoPos.toString()) })
  }

  /**
   * Get the challenge data for a UTXO
   *
   * @method getChallengeData
   * @param {Object} utxo
   * @return {string} challenge data for the UTXO
   */
  async getChallengeData (utxoPos) {
    return rpcApi.post(`${this.watcherUrl}/utxo.get_challenge_data`, { utxo_pos: Number(utxoPos.toString()) })
  }

  /**
   * Create an unsigned transaction
   *
   * @method createTransaction
   * @param {Object} transactionBody
   * @return {string} unsigned transaction
   */
  createTransaction (transactionBody) {
    transaction.validate(transactionBody)
    return transaction.encode(transactionBody)
  }

  /**
   * Sign a transaction
   *
   * @method signTransaction
   * @param {string} typedData
   * @param {Array} privateKeys
   * @return {Array} array of signatures
   */
  signTransaction (typedData, privateKeys) {
    privateKeys.forEach(key => validatePrivateKey)
    const jsonData = JSON.parse(typedData)
    const toSign = transaction.signHash(jsonData)
    return sign(toSign, privateKeys)
  }

  /**
   * Build a signed transaction into the format expected by submitTransaction
   *
   * @method buildSignedTransaction
   * @param {string} txData
   * @param {Array} signatures
   * @return {string} signed transaction
   */
  buildSignedTransaction (txData, signatures) {
    // Convert the data to an array
    const jsonData = JSON.parse(txData) // TODO validate this
    const txArray = transaction.toArray(jsonData.message)
    // Append the signatures
    const signedTx = [signatures, ...txArray]
    // rlp-encode the transaction + signatures
    return rlp.encode(signedTx).toString('hex')
  }

  /**
   * Submit a signed transaction to the watcher
   *
   * @method submitTransaction
   * @param {string} transaction
   * @return {Object} the submitted transaction
   */
  async submitTransaction (transaction) {
    // validateTxBody(transactionBody)
    return rpcApi.post(`${this.watcherUrl}/transaction.submit`, {
      transaction: transaction.startsWith('0x') ? transaction : `0x${transaction}`
    })
  }

  /**
   * create, sign, build and submit a transaction to the childchain using raw privatekey
   *
   * @method sendTransaction
   * @param {Array} fromAddress - the address of the sender
   * @param {Array} fromUtxos - array of utxos to spend
   * @param {Array} fromPrivateKeys - private keys of the utxos to spend
   * @param {string} toAddress - the address of the recipient
   * @param {number} toAmount - amount to transact
   * @return {Object} the submitted transaction
   */
  async sendTransaction (fromAddress, fromUtxos, fromPrivateKeys, toAddress, toAmount, currency) {
    validateAddress(fromAddress)
    validateAddress(toAddress)
    validatePrivateKey(fromPrivateKeys)

    // create the transaction body
    const txBody = transaction.createTransactionBody(fromAddress, fromUtxos, toAddress, toAmount, currency)
    // Get the transaction data
    const typedData = transaction.getTypedData(txBody)
    // Sign it
    const signatures = this.signTransaction(typedData, fromPrivateKeys)
    // Build the signed transaction
    const signedTx = this.buildSignedTransaction(typedData, signatures)
    // submit transaction
    return this.submitTransaction(signedTx)
  }

  /**
   * Returns the current status of the Watcher.
   * Should be called periodically to see if there are any byzantine_events to be acted on.
   *
   * @method status
   * @return {Object}
   */
  async status () {
    return rpcApi.post(`${this.watcherUrl}/status.get`, {})
  }

  /**
   * Get the exit data for an in-flight transaction
   *
   * @method inFlightExitGetData
   * @param {string} txbytes the hex-encoded transaction
   * @return {Object} exit data for the in-flight transaction
   */
  async inFlightExitGetData (txbytes) {
    return rpcApi.post(`${this.watcherUrl}/in_flight_exit.get_data`, { txbytes: hexPrefix(txbytes) })
  }

  /**
   * Get a competitor for an in-flight transaction
   *
   * @method inFlightExitGetCompetitor
   * @param {string} txbytes the hex-encoded transaction
   * @return {Object} a competitor to the in-flight transaction
   */
  async inFlightExitGetCompetitor (txbytes) {
    return rpcApi.post(`${this.watcherUrl}/in_flight_exit.get_competitor`, { txbytes: hexPrefix(txbytes) })
  }

  /**
   * Proves that a transaction has been put into a block (and therefore is canonical).
   *
   * @method inFlightExitProveCanonical
   * @param {string} txbytes the hex-encoded transaction
   * @return {Object} the inclusion proof of the transaction
   */
  async inFlightExitProveCanonical (txbytes) {
    return rpcApi.post(`${this.watcherUrl}/in_flight_exit.prove_canonical`, { txbytes: hexPrefix(txbytes) })
  }
}

function hexPrefix (data) {
  return data.startsWith('0x') ? data : `0x${data}`
}

function validatePrivateKey (arg) {
  // TODO
  const valid = true
  if (!valid) {
    throw new InvalidArgumentError()
  }
}

function validateAddress (arg) {
  // TODO
  const valid = true
  if (!valid) {
    throw new InvalidArgumentError()
  }
}

module.exports = ChildChain
