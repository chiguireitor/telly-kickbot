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

const Tgfancy = require('tgfancy')
const fs = require('fs')
const colors = require('colors')
const config = JSON.parse(fs.readFileSync('./config.json').toString('utf8').trim())
const util = require('util')
const moment = require('moment')
const merge = require('merge')
const bitcoin = require('bitcoinjs-lib')
const bitcoinMessage = require('bitcoinjs-message')
const crypto = require('crypto')
const Sequelize = require('sequelize')
const http = require('http')
const urlparse = require('url-parse')
const WebSocket = require('ws')
const sequelize = new Sequelize('kickbot', '', '', config.sqlite)
const xcp = require('./xcp.js')
const tgToken = process.env.TELEGRAM_TOKEN || config.token
const ownId = parseInt(tgToken.split(':')[0])

var User = sequelize.define('user', {
  tid: Sequelize.STRING,
  address: Sequelize.STRING,
  challenge: Sequelize.STRING,
  last_verify: Sequelize.DATE
})

var Group = sequelize.define('group', {
  tid: Sequelize.STRING,
  token: Sequelize.STRING,
  min_hold: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1}
})

var GroupUser = sequelize.define('group_user', {
  group_id: Sequelize.INTEGER,
  user_id: Sequelize.INTEGER,
  group_tid: Sequelize.STRING,
  user_tid: Sequelize.STRING,
  join_date: {type: Sequelize.DATE, defaultValue: Sequelize.NOW}
})

GroupUser.hasOne(User, {foreignKey: 'user_id'})
User.hasMany(GroupUser, {})
GroupUser.hasOne(Group, {foreignKey: 'group_id'})

User.sync()
Group.sync()
GroupUser.sync()

const bot = new Tgfancy(tgToken, {
  polling: true,
  tgfancy: {
      /*webSocket: {
          url: "wss://telegram-websocket-bridge-qalwkrjzzs.now.sh",
          autoOpen: true,
      },*/
  },
})

bot.getMe().then((data)=> {
  console.log(util.inspect(data, {colors: true, depth: 4}))
})

function removeUserGroup(uid, gid) {
  sequelize.transaction(function (trans) {
    return GroupUser.destroy({
        where: {group_tid: gid, user_tid: uid},
        transaction: trans
      }).then(User.destroy({
        where: {tid: uid},
        transaction: trans
      })).catch((err) => {
        console.log('Error'.bgRed.yellow, err)
      })
    })
}

bot.on('message', (msg) => {
  if (msg.new_chat_member && (msg.new_chat_member.id !== ownId)) {
    sequelize.transaction(function (trans) {
      return GroupUser.findOrCreate({
          where: {group_tid: msg.chat.id, user_tid: msg.new_chat_member.id},
          defaults: {group_tid: msg.chat.id, user_tid: msg.new_chat_member.id},
          transaction: trans
        }).then(User.findOrCreate({
          where: {tid: msg.new_chat_member.id},
          defaults: {tid: msg.new_chat_member.id},
          transaction: trans
        })).then(Group.findOrCreate({
          where: {tid: msg.chat.id},
          defaults: {tid: msg.chat.id},
          transaction: trans
        })).then(() => {
          bot.sendMessage(msg.chat.id, 'Hello ' + msg.new_chat_member.first_name +'! PM me or get kicked, you have 15 minutes to act.')
        }).catch((err) => {
          console.log('Error'.bgRed.yellow, err)
        })
    })
  } else if (msg.left_chat_member) {
    removeUserGroup(msg.left_chat_member.id, msg.chat.id)
  }

  if (msg.chat.id > 0) {
    User.findOrCreate({where: {tid: msg.chat.id}, defaults: {tid: msg.chat.id}})
      .then(([user]) => {
        handleUserMessage(msg, user)
      })
  }

})

bot.onText(/\/help/, (msg, match) => {
  if ((msg.chat.type == 'group') || (msg.chat.type == 'supergroup')) {

    Group.findOrCreate({
      where: {tid: msg.chat.id},
      defaults: {
        tid: msg.chat.id,
        token: ''
      }
    }).then(function(group) {
      bot.sendMessage(msg.chat.id, 'Issue /token to lock this group to a XCP token holding.'+
        '\nUse /required for minimum amount of token holded to be accepted.'+
        ((msg.chat.type == 'supergroup')?'':'\nThe group needs to be a supergroup and the bot needs to be an admin to work.'+
        '\nDue to limitation on the telegram client, this actions can only be performed on the mobile.'))
    })
  }
})

bot.onText(/\/token(.*)/, (msg, token) => {
  const chatId = msg.chat.id
  var currentAsset

  if (token[1] && (token[1].length > 0)) {
    bot.getChatAdministrators(chatId)
      .then((admins) => {
      let admin = admins.find(m => m.user.id == msg.from.id)
      if (msg.chat.all_members_are_administrators || admin) {
        xcp.getAsset(token[1])
          .then((data) => {
            if (data.error) {
              bot.sendMessage(chatId, data.error)
            } else {
              currentAsset = data.asset
              return Group.findOrCreate({
                where: {tid: msg.chat.id},
                defaults: {
                  tid: msg.chat.id,
                  token: data.asset
                }
              })
            }
          })
          .then(([group], created) => {
            if (!created) {
              //console.log(util.inspect(group, {colors: true, depth: 3}))
              group.token = currentAsset
              return group.save()
            } else {
              return false
            }
          })
          .then((changed) => {
            if (changed) {
              bot.sendMessage(chatId, 'Token changed!')
            } else {
              bot.sendMessage(chatId, 'Token setup!')
            }
          })
          .catch((err) => {
            console.log(err)
            bot.sendMessage(chatId, 'Token invalid or API unavailable')
          })
      } else {
        bot.sendMessage(chatId, 'Nice try :smirk:')
      }
    }).catch((e) => {
      console.log(e)
      bot.sendMessage(chatId, 'There was an error, try later.')
    })
  } else {
    Group.findOrCreate({where: {tid: msg.chat.id}})
      .then(([data]) => {
        bot.sendMessage(chatId, 'Current token is ' + data.token + ', min holding required is ' + data.min_hold)
      })
  }

})

bot.onText(/\/required(.*)/, (msg, token) => {
  const chatId = msg.chat.id
  var currentAsset

  if (token[1] && (token[1].length > 0)) {
    let minAmount = parseInt(token[1])

    if (!Number.isNaN(minAmount)) {
      bot.getChatAdministrators(chatId)
        .then((admins) => {
        let admin = admins.find(m => m.user.id == msg.from.id)
        if (msg.chat.all_members_are_administrators || admin) {
          Group.findOrCreate({
              where: {tid: msg.chat.id},
              defaults: {
                tid: msg.chat.id,
                min_hold: minAmount
              }
            }).then(([group], created) => {
              if (!created) {
                //console.log(util.inspect(group, {colors: true, depth: 3}))
                group.min_hold = minAmount
                return group.save()
              } else {
                return false
              }
            }).then((changed) => {
              if (changed) {
                bot.sendMessage(chatId, 'Minimum amount changed!')
              } else {
                bot.sendMessage(chatId, 'Minimum amount setup!')
              }
            })
        } else {
          bot.sendMessage(chatId, 'Nice try :smirk:')
        }
      }).catch((e) => {
        console.log(e)
        bot.sendMessage(chatId, 'There was an error, try later.')
      })
    }
  } else {
    Group.findOrCreate({where: {tid: msg.chat.id}})
      .then(([data]) => {
        bot.sendMessage(chatId, 'Current minimum held is ' + data.min_hold + ' ' + data.token)
      })
  }

})

bot.onText(/\/validate/, (msg) => {
  const chatId = msg.chat.id

  bot.getChat(chatId)
    .then((data) => {
      console.log(util.inspect(data, {colors: true, depth: 3}))
      bot.sendMessage(chatId, 'test')
    })
})

bot.onText(/\/address (.+)/, (msg, match) => {
  const chatId = msg.chat.id
  const resp = match[1]

  bot.sendMessage(chatId, resp)
})

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id

  if (!msg.group) {
    //bot.sendMessage(chatId, "Send me your address")
  }
})

function randomString(cb) {
  crypto.randomBytes(10, function(err, buffer) {
    if (err) {
      cb(err)
    } else {
      cb(null, buffer.toString('hex'))
    }
  })
}

var challengeWaits = {}
var waitChallenge = function() {}

if (config.wsAuthUrl) {
  const ws = new WebSocket(config.wsAuthUrl)

  ws.on('message', function incoming(data, flags) {
    try {
      let ob = JSON.parse(data)

      if ('verified' in ob) {
        challengeWaits[ob.challenge](true)
      }
    } catch (e) {
      console.log('Malformed data from websocket')
    }
  })

  waitChallenge = function(chall, cb) {
    challengeWaits[chall] = cb

    ws.send(JSON.stringify({
      challenge: chall
    }))
  }
}

function handleUserMessage(msg, user) {
  if (config.authUrl) {
    randomString((err, s) => {
      if (err) {
        bot.sendMessage(msg.chat.id, 'There was an error generating the challenge. Try again later.')
      } else {
        user.address = msg.text.trim()
        user.challenge = s
        user.last_verify = 0
        user.save().then(() => {
          bot.sendMessage(msg.chat.id, "Go to the following link to verify your address.")
          bot.sendMessage(msg.chat.id, "https://rarepepewallet.com/?msg=" + user.challenge + "&return=" + config.authUrl)
          waitChallenge(user.challenge, (verified) => {
            if (verified) {
              user.last_verify = Date.now()
              user.save().then(() => {
                bot.sendMessage(msg.chat.id, "You're verified, you won't be kicked from groups which you meet the requirement.")
              }).catch(() => {
                bot.sendMessage(msg.chat.id, 'There was an error saving user data. Try again later.')
              })
            }
          })
        }).catch(() => {
          bot.sendMessage(msg.chat.id, 'There was an error saving user data. Try again later.')
        })
      }
    })
  } else {
    if (!user.address) {
      try {
        let addr = msg.text.trim()
        bitcoin.address.fromBase58Check(addr)

        randomString((err, s) => {
          if (err) {
            bot.sendMessage(msg.chat.id, 'There was an error generating the challenge. Try again later.')
          } else {
            user.address = msg.text.trim()
            user.challenge = s
            user.last_verify = 0
            user.save().then(() => {
              bot.sendMessage(msg.chat.id, "Now sign the following message and send the result to me.")
              bot.sendMessage(msg.chat.id, user.challenge)
            }).catch(() => {
              bot.sendMessage(msg.chat.id, 'There was an error saving user data. Try again later.')
            })

          }
        })
      } catch(e) {
        console.log(e)
        bot.sendMessage(msg.chat.id, "First send me your address")
      }
    } else {
      bot.sendMessage(msg.chat.id, 'Checking your signature.')
      let verify = bitcoinMessage.verify(user.challenge, bitcoin.networks.bitcoin.messagePrefix, user.address, msg.text.trim())
      if (verify) {
        user.last_verify = Date.now()
        user.save().then(() => {
          bot.sendMessage(msg.chat.id, "You're verified, you won't be kicked from groups which you meet the requirement.")
        }).catch(() => {
          bot.sendMessage(msg.chat.id, 'There was an error saving user data. Try again later.')
        })
      } else {
        bot.sendMessage(msg.chat.id, "Bad signature, try again.")
      }
    }
  }
}

setInterval(() => {
  let checks = {}
  let addrToUid = {}
  let bans = []

  function includeCheck(addr, uid, token, gid, amnt) {
    if (!(addr in checks)) {
      checks[addr] = {}
    }

    if (!(token in checks[addr])) {
      checks[addr][token] = []
    }

    checks[addr][token].push({gid, amnt, uid})
    addrToUid[addr] = uid
  }

  function checkBals(addr, bals, uid) {
    if (addr in checks) {
      let chk = checks[addr]

      for (let token in chk) {
        let grps = chk[token]

        if (token in bals) {
          for (let i=0; i < grps.length; i++) {
            if (grps[i].amnt > bals[token]) {
              bans.push({
                gid: grps[i].gid,
                uid,
                addr
              })
            }
          }
        } else {
          for (let i=0; i < grps.length; i++) {
            bans.push({
              gid: grps[i].gid,
              uid,
              addr
            })
          }
        }
      }
    }
  }

  GroupUser.findAll({include: [User, Group]}).then((grusrs) => {
    let gets = []
    for (let i=0; i < grusrs.length; i++) {
      let grusr = grusrs[i]

      //console.log('Getting usr:', grusr.user_tid, 'grp:', grusr.group_tid)

      gets.push(Promise.all([
        User.find({where: {tid: grusr.user_tid}}),
        Group.find({where: {tid: grusr.group_tid}}),
        grusr
      ]))
    }
    return Promise.all(gets)
  }).then((usrGrps) => {
    let users = []
    let gets = []
    let orderedAssets = []
    let assets = {}

    for (let i=0; i < usrGrps.length; i++) {
      let usr = usrGrps[i][0]
      let grp = usrGrps[i][1]
      let grusr = usrGrps[i][2]

      if  (usr) {
        if (!usr.last_verify) {
          let start = moment(Date.now())
          let end = moment(grusr.join_date)
          let diff = start.diff(end)

          if (diff > (config.maxSecondsWithoutVerify * 1000)) {
            bans.push({
              gid: grp.tid,
              uid: usr.tid,
              addr: usr.address
            })
          }
        } else {
          includeCheck(usr.address, usr.tid, grp.token, grp.tid, grp.min_hold)
          assets[grp.token] = true
          users.push({address: usr.address, tid: usr.tid}) //xcp.getUser(usr.address))
        }
      }
    }

    for (let token in assets) {
      gets.push(xcp.getAssetHolders(token))
      orderedAssets.push(token)
    }


    return Promise.all(gets)
  }).then((chckds) => {
    let holders = chckds.reduce((p, n) => merge(p, n), {})

    for (let i=0; i < holders.length; i++) {
      for (let addr in holders[i]) {
        let bals = holders[i][addr]
        checkBals(addr, bals, addrToUid[addr])
      }
    }

    for (let i=0; i < bans.length; i++) {
      let ban = bans[i]
      if (ban.uid != ownId) {
        console.log('KICK'.bgRed.yellow, ban.addr)
        bot.kickChatMember(ban.gid, ban.uid)
        removeUserGroup(ban.uid, ban.gid)
      }
    }
  })
}, 1000 * config.secondsVerify)

function searchGroups() {
  sequelize.transaction(function (trans) {
    return Group.findAll({transaction: trans}).then((grps) => {
        return Promise.all(grps.map(x => bot.getChat(x.tid)))
      }).then((chats) => {
        console.log(util.inspect(chats, {colors: true, depth: 4}))
      }).catch((err) => {
        console.log('Error'.bgRed.yellow, err)
      })
  })
}
