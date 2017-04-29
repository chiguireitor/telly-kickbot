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
  tid: {type: Sequelize.STRING, primaryKey: true},
  address: Sequelize.STRING,
  challenge: Sequelize.STRING,
  last_verify: Sequelize.DATE
})

var Group = sequelize.define('group', {
  tid: {type: Sequelize.STRING, primaryKey: true},
  token: Sequelize.STRING,
  min_hold: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1}
})

var GroupUser = sequelize.define('group_user', {
  group_tid: {type: Sequelize.STRING, primaryKey: true},
  user_tid: {type: Sequelize.STRING, primaryKey: true},
  join_date: {type: Sequelize.DATE, defaultValue: Sequelize.NOW}
})

var BannedGroupUser = sequelize.define('banned_group_user', {
  group_tid: {type: Sequelize.STRING, primaryKey: true},
  user_tid: {type: Sequelize.STRING, primaryKey: true}
})

GroupUser.hasOne(User, {foreignKey: 'user_tid'})
//User.hasMany(GroupUser, {})
GroupUser.hasOne(Group, {foreignKey: 'group_tid'})
BannedGroupUser.hasOne(User, {foreignKey: 'user_tid'})
BannedGroupUser.hasOne(Group, {foreignKey: 'group_tid'})

User.sync()
Group.sync()
GroupUser.sync()
BannedGroupUser.sync()

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

function removeUserGroup(uid, gid, prevTran) {
  let onTrans = function (trans) {
    return GroupUser.destroy({
        where: {group_tid: gid, user_tid: uid},
        transaction: trans
      }).then(BannedGroupUser.findOrCreate({
        where: {group_tid: gid, user_tid: uid},
        defaults: {group_tid: gid, user_tid: uid},
        transaction: trans
      })).catch((err) => {
        console.log('Error'.bgRed.yellow, err)
      })
    }

  if (prevTran) {
    onTrans(prevTran)
  } else {
    sequelize.transaction(onTrans)
  }
}

bot.on('message', (msg) => {
  console.log(util.inspect(msg, {colors: true, depth: 3}))
  let memberId = msg.new_chat_member?msg.new_chat_member.id:(msg.from?msg.from.id:null)
  let memberName = msg.new_chat_member?msg.new_chat_member.first_name:(msg.from?msg.from.first_name:null)
  if (memberId !== ownId) {
    //console.log(msg, 'using member id', memberId)
    sequelize.transaction(function (trans) {
      return GroupUser.findOrCreate({
          where: {group_tid: msg.chat.id, user_tid: memberId},
          defaults: {group_tid: msg.chat.id, user_tid: memberId},
          transaction: trans
        }).then(() => Group.findOrCreate({
          where: {tid: msg.chat.id},
          defaults: {tid: msg.chat.id},
          transaction: trans
        })).then(() => User.findOrCreate({
          where: {tid: memberId},
          defaults: {tid: memberId},
          transaction: trans
        })).then(([usr, created]) => {
          if (created) {
            bot.sendMessage(msg.chat.id, 'Hello ' + memberName +'! PM me or get kicked, you have 15 minutes to act.')
          }
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
          .then(([group, created]) => {
            if (!created) {
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

bot.onText(/\/unlink/, (msg) => {
  const chatId = msg.chat.id

  if (!msg.group) {
    User.findAll({where: {tid: msg.chat.id}})
      .then(([user]) => {
        user.address = 0
        user.challenge = 0
        user.last_verify = 0
        return user.save()
      })
      .then(() => {
        bot.sendMessage(chatId, "Address unlinked")
      })
      .catch((e) => {
        console.log(e)
        bot.sendMessage(chatId, "Something bad happened")
      })
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
  var ws

  function connectWs() {
    ws = new WebSocket(config.wsAuthUrl)

    ws.on('message', function incoming(data, flags) {
      try {
        let ob = JSON.parse(data)

        console.log('Websocket info', util.inspect(ob))

        if ('verified' in ob) {
          challengeWaits[ob.challenge](ob)
        }
      } catch (e) {
        console.log('Malformed data from websocket', e)
      }
    })

    ws.on('close', connectWs)
  }
  connectWs()

  waitChallenge = function(chall, cb) {
    challengeWaits[chall] = cb

    console.log('Sending challenge', chall)
    ws.send(JSON.stringify({
      challenge: chall
    }))
  }
}

function handleUserMessage(msg, user) {
  if (config.authUrl) {
    if (user.address && (user.address != '0')) {
      bot.sendMessage(msg.chat.id, 'You\'re all set, issue /unlink to remove your address from your user.')
    } else {
      randomString((err, s) => {
        if (err) {
          bot.sendMessage(msg.chat.id, 'There was an error generating the challenge. Try again later.')
        } else {
          user.challenge = s
          user.last_verify = 0
          user.save().then(() => {
            bot.sendMessage(msg.chat.id, "Go to the following link to verify your address.", {
              reply_markup: JSON.stringify({
                inline_keyboard: [
                  [{
                    text: 'Verify on rarepepewallet.com',
                    url: "https://rarepepewallet.com/?msg=" + user.challenge + "&return=" + encodeURIComponent(config.authUrl)
                  }/*,
                  {
                    text: "Verify on IndieSquare",
                    url: "https://cryptoauthproxy-rwayxwtfhk.now.sh/indiesquare?msg=" + user.challenge + "&x-success=" + encodeURIComponent(config.authUrl)
                  }*/]
                ]
              })
            })

            waitChallenge(user.challenge, (data) => {
              if (data && (data.challenge == user.challenge)) {
                user.address = data.verified
                user.last_verify = Date.now()
                user.save().then(() => {
                  bot.sendMessage(msg.chat.id, "You're verified, you won't be kicked from groups which you meet the requirement.")
                }).catch(() => {
                  bot.sendMessage(msg.chat.id, 'There was an error saving user data. Try again later.')
                })
              }
            })
          }).catch((err) => {
            console.log(err)
            bot.sendMessage(msg.chat.id, 'There was an error saving user data. Try again later.')
          })
        }
      })
    }
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

var cachedGroups
function gatherGroups() {
  if (cachedGroups) {
    return cachedGroups
  } else {
    return Group.findAll()
      .then((groups) => {
        let grps = groups.reduce((o, i) => {
          if (i.token) {
            if (!(i.token in o)) {
              o[i.token] = []
            }

            o[i.token].push({
              tid: i.tid,
              token: i.token,
              min_hold: i.min_hold,
              members: [],
              kicked: []
            })
          }
          return o
        }, {})

        return Promise.all([
          grps,
          GroupUser.findAll(),
          BannedGroupUser.findAll()
        ])
      })
      .then(([grps, gusers, bgusers]) => {
        let proc = (cat) => (item) => {
          for (let token in grps) {
            let g = grps[token].find((fg) => fg.tid == item.group_tid)

            if (g) {
              g[cat].push({
                address: null,
                tid: item.user_tid,
                join_date: item.join_date
              })
            }
          }
        }

        gusers.forEach(proc('members'))
        bgusers.forEach(proc('kicked'))

        return Promise.all([
          grps,
          User.findAll()
        ])
      })
      .then(([grps, users]) => {
        let searchByTid = tid => x => x.tid === tid

        users.forEach((user) => {
          for (let token in grps) {
            grps[token].forEach((group) => {
              group.members
                .filter(searchByTid(user.tid))
                .forEach(gm => {gm.address = user.address})
              group.kicked
                .filter(searchByTid(user.tid))
                .forEach(gm => {gm.address = user.address})
            })
          }
        })

        return grps
      })
  }
}

function forEachMemberInEachGroup(groups, category, filter) {
  for (let token in groups) {
    groups[token].forEach(group => {
      let list = group[category]

      if (list) {
        list.forEach(user => {
          filter(token, group, user)
        })
      }
    })
  }
}

function generateTimeBans(groups) {
  let bans = []

  forEachMemberInEachGroup(groups, 'members', (token, group, user) => {
    if (!user.createdAt) {
      //bans.push({gid: group.tid, uid: user.tid, reason: 'no-date', detail: {}})
    } else {
      let start = moment(Date.now())
      let end = moment(user.createdAt)
      let diff = start.diff(end)

      if ((diff > (config.maxSecondsWithoutVerify * 1000)) && !user.address) {
        bans.push({gid: group.tid, uid: user.tid, reason: 'validate-timeout', detail: {}})
      }
    }
  })

  return bans
}

function generateTokenBans(groups, holders) {
  let bans = []
  forEachMemberInEachGroup(groups, 'members', (token, group, user) => {
    if (user.address) {
      if (!(user.address in holders)) {
        console.log('No-token data:', group.tid, user.tid, user.address, group.token)
        bans.push({gid: group.tid, uid: user.tid, reason: 'no-token', detail: {token: group.token}})
      } else {
        let holdings = holders[user.address]
        if (!(group.token in holdings)) {
          console.log('No-token:', group.tid, user.tid, user.address, group.token)
          bans.push({gid: group.tid, uid: user.tid, reason: 'no-token', detail: {token: group.token}})
        } else {
          let balance = holdings[group.token]

          if (balance < group.min_hold) {
            console.log('No-min_hold:', group.tid, user.tid, user.address, group.token)
            bans.push({gid: group.tid, uid: user.tid, reason: 'no-min_hold', detail: {token: group.token, hold: group.min_hold}})
          }
        }
      }
    }
  })

  return bans
}

function generateTokenUnbans(groups, holders) {
  let unbans = []
  forEachMemberInEachGroup(groups, 'kicked', (token, group, user) => {
    if (user.address in holders) {
      let holdings = holders[user.address]
      if (group.token in holdings) {
        let balance = holdings[group.token]

        if (balance >= group.min_hold) {
          unbans.push({gid: group.tid, uid: user.tid, reason: 'good-balance', detail: {token: group.token, hold: group.min_hold}})
        }
      }
    }
  })

  return unbans
}

var cachedHolders
function getAllHolders(height, tokens) {
  const heightFilename = './lastHoldersHeight'
  const dataFilename = './lastHoldersData'
  return new Promise((resolve, reject) => {
    function download() {
      console.log('Downloading new holder list')
      Promise.all(tokens.map(token => xcp.getAssetHolders(token)))
        .then((tokens) => {
          cachedHolders = tokens.reduce((p, n) => merge.recursive(true, p, n), {})

          fs.writeFile(dataFilename, JSON.stringify(cachedHolders), (err) => {
            if (err) {
              resolve(cachedHolders)
            } else {
              fs.writeFile(heightFilename, ""+height, () => {
                resolve(cachedHolders)
              })
            }
          })
        })
    }

    fs.readFile(heightFilename, (err, data) => {
      if (err) {
        console.log('No height data for cached holders')
        download()
      } else {
        let fh = parseInt(data.toString())

        console.log('Previous height data, checking', fh, '=', height)

        if (fh === height) {
          fs.readFile(dataFilename, (err, data) => {
            if (err) {
              console.log('Error while reading cached holders')
              download()
            } else {
              console.log('Parsing cached holders data')
              cachedHolders = JSON.parse(data.toString('utf8'))

              resolve(cachedHolders)
            }
          })
        } else {
          console.log('Stale cache for holders')
          download()
        }
      }
    })
  })
}

function processBan(ban, transaction) {
  console.log(ban)
  return bot.kickChatMember(ban.gid, ban.uid)
    .then(removeUserGroup(ban.uid, ban.gid, transaction))
    .then(() => {
    let usrMessage, groupMessage
    if (ban.reason === 'no-token') {
      usrMessage =
        'Just banned you from a group because you don\'t meet the criteria:\n' +
        ' * You need to hold ' + ban.detail.token + '\n' +
        'Unfortunately, i don\'t know the group name :('

      groupMessage = 'Kicked that last one because he/she doesn\'t holds any of ' + ban.detail.token
    } else if (ban.reason === 'no-min_hold') {
      usrMessage =
        'Just banned you from a group because you don\'t meet the criteria:\n' +
        ' * You need at least' + ban.detail.hold + ' of ' + ban.detail.token + '\n' +
        'Unfortunately, i don\'t know the group name :('

      groupMessage = 'Kicked that last one because he/she doesn\'t holds enough ' + ban.detail.token
    } else if (ban.reason === 'no-date') {
      usrMessage = 'It seems i didn\'t see you join a group when i was coded well, sorry'
      groupMessage = 'That last one joined and i was badly coded, my bad'
    } else if (ban.reason === 'validate-timeout') {
      usrMessage = 'You failed to validate in time, whenever you validate you\'ll gain access to the groups you want'
      groupMessage = 'That last one didn\'t validate on time'
    } else {
      usrMessage = 'Sorry, banned you for an unknown reason'
      groupMessage = 'I felt like kicking someone (reason unknonw)'
    }

    let msgs = []

    if (usrMessage) {
      msgs.push(bot.sendMessage(ban.uid, usrMessage))
    }

    if (groupMessage) {
      msgs.push(bot.sendMessage(ban.gid, groupMessage))
    }

    return Promise.all(msgs)
  }).catch((err) => {
    if (err.message.indexOf('USER_NOT_PARTICIPANT') >= 0) {
      // User is not there, remove
      return removeUserGroup(ban.uid, ban.gid, transaction)
    } else if (err.message.indexOf('not enough rights') >= 0) {
      return bot.sendMessage(ban.gid, 'Hey admin! You should give me admin rights here')
    } else if (err.message.indexOf('USER_ADMIN_INVALID') >= 0) {
      console.log('Tried to kick an admin at', ban.gid, ban.uid)
      bot.getChatMember(ban.gid, ban.uid)
        .then((user) => {
          console.log('This was the one i tried to ban', user)
        })
    }
  })
}

function processUnban(unban, transaction) {
  console.log(unban)
  return bot.unbanChatMember(unban.gid, unban.uid)
    .then(BannedGroupUser.destroy({
      where: {group_tid: unban.gid, user_tid: unban.uid},
      transaction
    }))
    .then(([num]) => {

    let usrMessage, groupMessage
    let msgs = []
    if (num === 1) {
      if (unban.reason === 'good-balance') {
        usrMessage =
          'Just unbanned you from a group because you meet the criteria:\n' +
          ' * You have at least ' + unban.detail.hold + ' of ' + unban.detail.token + '\n' +
          'Unfortunately, i don\'t know the group name :('

        groupMessage = 'Just unbanned someone... don\'t know his/her name... sorry'
      }

      if (usrMessage) {
        msgs.push(bot.sendMessage(unban.uid, usrMessage))
      }

      if (groupMessage) {
        msgs.push(bot.sendMessage(unban.gid, groupMessage))
      }
    } else {
      msgs.push(bot.sendMessage(unban.uid, 'Tried to unban you, but it didn\'t work. Sorry.'))
    }

    return Promise.all(msgs)
  }).catch((err) => {
    if (err.message.indexOf('USER_NOT_PARTICIPANT') >= 0) {
      // User is not there, remove
      //removeUserGroup(ban.uid, ban.gid, transaction)
      return BannedGroupUser.destroy({
        where: {group_tid: unban.gid, user_tid: unban.uid},
        transaction
      })
    } else if (err.message.indexOf('not enough rights') >= 0) {
      return bot.sendMessage(unban.gid, 'Hey admin! You should give me admin rights here')
    } else if (err.message.indexOf('USER_ADMIN_INVALID') >= 0) {
      console.log('Tried to kick an admin at ' + unban.gid)
    }
  })
}

function processBotAndDBActions(bans, unbans) {
  return sequelize.transaction((transaction) => {
    return Promise.all(
      bans.map(ban => processBan(ban, transaction)).concat(
      unbans.map(unban => processUnban(unban, transaction))
    ))
  })
}

function wholeCheck() {
  Promise.all([xcp.hasNewBlock(), gatherGroups()])
    .then(([{isNew, height}, groups]) => {
      if (isNew) {
        return Promise.all([groups, getAllHolders(height, Object.keys(groups))])
      } else {
        return [groups, cachedHolders]
      }
    })
    .then(([groups, holders]) => {
      let timeBans = generateTimeBans(groups)
      let tokenBans = generateTokenBans(groups, holders)
      let bans = timeBans.concat(tokenBans)

      let unbans = generateTokenUnbans(groups, holders)

      return processBotAndDBActions(bans, unbans)
    })
    .catch((err) => {
      console.log(err)
      throw err
    })
}

setTimeout(wholeCheck, 2000)
setInterval(wholeCheck, 1000 * config.secondsVerify)

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
