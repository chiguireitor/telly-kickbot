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
      getJSON(xcpAPI + 'holders/' + asset, function(error, response){
        if (error) {
          reject(error)
        } else {
          let holders = {}
          response.data.forEach((holder) => {
            let tb = {}
            tb[asset] = parseFloat(holder.amount)
            holders[holder.address] = tb
          })
          resolve(holders)
        }
      })
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

module.exports = {
  getAsset,
  getAssetHolders,
  getUserBalance,
  getUser
}
