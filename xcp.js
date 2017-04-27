/**
* Copyright (c) 2017 Chiguireitor
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in
* all copies or substantial portions of the Software.
*/
'use strict'


const getJSON = require('get-json')
const xcpAPI = 'https://counterpartychain.io/api/'

var currentBlock = 0

function getAsset(asset) {
  asset = asset.trim()
  return new Promise((resolve,reject) => {
    if (asset.length <= 12) {
      getJSON(xcpAPI + 'asset/' + asset, function(error, response){
        if (error) {
          reject(error)
        } else {
          resolve(response)
        }
      })
    } else {
      reject(new Error('Assets must be 12 characters or less'))
    }
  })
}

function getAssetHolders(asset) {
  asset = asset.trim()
  return new Promise((resolve,reject) => {
    if (asset.length <= 12) {
      let page = 1
      let processed = 0
      let total = 1
      let holders = {}

      function getPage() {
        getJSON(xcpAPI + 'holders/' + asset + '/' + page, function(error, response){
          console.log('Getting page ' + page + ' for asset ' + asset)
          if (error) {
            reject(error)
          } else {
            total = parseInt(response.total)
            response.data.forEach((holder) => {
              let tb = {}
              tb[asset] = parseFloat(holder.amount)
              holders[holder.address] = tb
            })
            processed += response.data.length

            page++

            if (processed < total) {
              getPage()
            } else {
              resolve(holders)
            }
          }
        })
      }

      getPage()
    } else {
      reject(new Error('Assets must be 12 characters or less'))
    }
  })
}

function getUserBalance(addr, asset) {
  asset = asset.trim()
  addr = addr.trim()
  return new Promise((resolve,reject) => {
    if (asset.length <= 12) {
      getJSON(xcpAPI + 'balances/' + addr, function(error, response){
        if (error) {
          reject(error)
        } else {
          let result = response.data.find(x => x.asset == asset)
          resolve(result)
        }
      })
    } else {
      reject(new Error('Assets must be 12 characters or less'))
    }
  })
}

function getUser(addr) {
  return new Promise((resolve,reject) => {
    if (addr) {
      addr = addr.trim()
      getJSON(xcpAPI + 'balances/' + addr, function(error, response){
        if (error) {
          reject(error)
        } else {
          let result = {}
          response.data.forEach((x) => {
            result[x.asset] = parseFloat(x.amount)
          })

          let ob = {}
          ob[addr] = result

          resolve(ob)
        }
      })
    } else {
      resolve({})
    }
  })
}

function hasNewBlock() {
  return new Promise((resolve, reject) => {
    getJSON('http://public.coindaddy.io:4100/', function(error, response){
      if (!error) {
        let lastbi = response.counterblock_last_processed_block.block_index

        if (currentBlock < lastbi) {
          currentBlock = lastbi
          resolve({isNew: true, height: lastbi})
        } else {
          resolve({isNew: false, height: lastbi})
        }
      } else {
        reject(error)
      }
    })
  })
}

module.exports = {
  getAsset,
  getAssetHolders,
  getUserBalance,
  getUser,
  hasNewBlock
}
