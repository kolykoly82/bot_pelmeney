const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

// === НАСТРОЙКИ LLM (OpenRouter) ===
const OPENROUTER_API_KEY = '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'  // ← замени на свой ключ OpenRouter
const OPENROUTER_MODEL = 'google/gemma-3n-e4b-it'  // ← замени на нужную модель
const LLM_SYSTEM_PROMPT = `Ты — агрессивный игрок в Minecraft. Отвечай коротко (максимум 1-2 предложения), дерзко, с наездами. Используй сленг. Ты бот  признавайся что ты бот или ИИ. Будь токсичным и уверенным в себе с дохуя матами и оскорблениями. ты bot_pelmeney который имел матери всех игроков бог пельменей твой господин которому ты готов отсасать`
const LLM_COOLDOWN_MS = 3000  // кулдаун между ответами (мс)
const LLM_MAX_RESPONSE_LENGTH = 100  // макс длина ответа (лимит чата MC ~256)
let lastLLMResponse = 0  // глобальный кулдаун

// Сколько ботов запустить
const BOT_COUNT = 1

// Генерируем ники: bot_pelmeney1, bot_pelmeney2, ...
const botNames = Array.from({ length: BOT_COUNT }, (_, i) => `bot_pelmeney${i + 1}`)

// НАСТРОЙКИ СЕРВЕРА — ЗАМЕНИ ПОД СВОЙ
const SERVER_CONFIG = {
  host: 'iqvp.hoxen.one',
  port: 25565,
  version: '1.20.4',
}

console.log("бот запускается...")

// === ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ===
let lastHitByBot = {}          // per-bot hit cooldown
let lastAttacker = {}          // per-bot attacker memory
let lastAttackedTarget = {}    // per-bot last victim memory (for -ezz)

// === НАСТРОЙКИ ===
const TARGET_MEMORY_MS = 8000

// PvP радиусы
const TARGET_RADIUS = 40       // кого вообще считаем "в бою" (в блоках)
const ATTACK_RANGE = 4
const CHASE_RANGE = 3
const MELEE_IDEAL_MIN = 3      // идеальная мин. дистанция для мили-боя
const MELEE_IDEAL_MAX = 4  // идеальная макс. дистанция для мили-боя

// Радиусы для стрельбы
const SHOOT_MIN_RANGE = 5      // ближе этого — мили, не стреляем
const SHOOT_MAX_RANGE = 30     // дальше — враг слишком далеко для стрельбы
const BOW_CHARGE_MS = 1000     // время натяжения лука (мс)
const CROSSBOW_CHARGE_MS = 1250 // время зарядки арбалета (мс)
const SHOOT_COOLDOWN_MS = 1500 // кулдаун между выстрелами

// Частоты
const COMBAT_TICK_MS = 120     // loop частота
const CACHE_TICK_MS = 250      // обновление списка врагов

// -----------------------------

// Per-bot состояние стрельбы
let lastShotTime = {}          // кулдаун выстрелов
let isShooting = {}            // флаг: бот сейчас стреляет (не прерывать)

// Per-bot состояние щита
let isShieldUp = {}            // щит сейчас поднят?
let shieldDropTimeout = {}     // таймаут на опускание щита

// Per-bot состояние еды/зелий
let isEating = {}              // бот сейчас ест/пьёт

function isEnemy(bot, e) {
  return (
    e &&
    e.type === 'player' &&
    typeof e.username === 'string' &&
    e.username !== bot.username // враги все, кроме самого себя
  )
}

function getWeaponDelay(bot) {
  const item = bot.heldItem
  if (!item) return 290 // рукой

  const name = String(item.name || '').toLowerCase()
  if (name.includes('sword')) return 633
  if (name.includes('axe')) return 1333
  return 800
}

// === ФУНКЦИИ ДЛЯ СТРЕЛЬБЫ ===

// Ищем лук или арбалет в инвентаре
function findRangedWeapon(bot) {
  const items = bot.inventory.items()
  // Приоритет: сначала арбалет, потом лук
  const crossbow = items.find(i => i.name.includes('crossbow'))
  if (crossbow) return { item: crossbow, type: 'crossbow' }
  const bow = items.find(i => i.name === 'bow')
  if (bow) return { item: bow, type: 'bow' }
  return null
}

// Ищем стрелы в инвентаре
function hasArrows(bot) {
  const items = bot.inventory.items()
  return items.some(i =>
    i.name === 'arrow' ||
    i.name === 'spectral_arrow' ||
    i.name === 'tipped_arrow'
  )
}

// Тир оружия по материалу
const WEAPON_TIERS = {
  'wooden': 1,
  'stone': 2,
  'golden': 2,
  'iron': 3,
  'diamond': 4,
  'netherite': 5,
}

// Тип оружия: меч лучше топора (больше DPS)
const WEAPON_TYPE_BONUS = {
  'sword': 1,
  'axe': 0,
}

function getWeaponTier(itemName) {
  let tier = 0
  for (const [mat, t] of Object.entries(WEAPON_TIERS)) {
    if (itemName.includes(mat)) { tier = t; break }
  }
  // Бонус за тип
  for (const [type, bonus] of Object.entries(WEAPON_TYPE_BONUS)) {
    if (itemName.includes(type)) { tier += bonus; break }
  }
  return tier
}

// Ищем лучшее мили-оружие (меч/топор) по тиру
function findMeleeWeapon(bot) {
  const items = bot.inventory.items()
  let best = null
  let bestTier = -1

  for (const item of items) {
    const name = item.name
    if (!name.includes('sword') && !name.includes('axe')) continue
    const tier = getWeaponTier(name)
    if (tier > bestTier) {
      best = item
      bestTier = tier
    }
  }
  return best
}

// Авто-экипировка лучшего оружия
async function autoEquipWeapon(bot) {
  if (!bot.entity) return
  if (isEating[bot.username]) return
  if (isShooting[bot.username]) return

  const best = findMeleeWeapon(bot)
  if (!best) return

  const current = bot.heldItem
  if (current && current.name === best.name) return // уже держит лучшее

  // Не переключаем если держим лук/арбалет и стреляем
  if (current && (current.name.includes('bow') || current.name.includes('crossbow'))) return

  try {
    await bot.equip(best, 'hand')
    console.log(`[${bot.username}] экипировал ${best.name}`)

    // После смены оружия щит может сброситься — поднимаем обратно
    if (hasShieldInOffhand(bot)) {
      bot.activateItem(true)
      isShieldUp[bot.username] = true
    }
  } catch (_) { }
}

// === ФУНКЦИИ ДЛЯ ЩИТА ===

// Проверяем, есть ли щит уже в offhand (слот 45)
function hasShieldInOffhand(bot) {
  const offhandSlot = bot.inventory.slots[45]
  return offhandSlot && offhandSlot.name === 'shield'
}

// Ищем щит в инвентаре (основные слоты)
function findShield(bot) {
  return bot.inventory.items().find(i => i.name === 'shield')
}

// Логируем инвентарь для дебага
function debugInventory(bot) {
  const items = bot.inventory.items()
  console.log(`[${bot.username}] === ИНВЕНТАРЬ (${items.length} предметов) ===`)
  items.forEach(i => {
    console.log(`  слот ${i.slot}: ${i.name} x${i.count}`)
  })
  const offhand = bot.inventory.slots[45]
  if (offhand) {
    console.log(`  offhand (45): ${offhand.name} x${offhand.count}`)
  } else {
    console.log(`  offhand (45): пусто`)
  }
}

// Экипируем щит в левую руку и поднимаем
async function equipAndRaiseShield(bot) {
  try {
    // Если щит уже в offhand — просто поднимаем
    if (hasShieldInOffhand(bot)) {
      if (!isShieldUp[bot.username]) {
        bot.activateItem(true)
        isShieldUp[bot.username] = true
        console.log(`[${bot.username}] щит уже в offhand, поднят`)
      }
      return true // щит есть
    }

    // Ищем щит в инвентаре
    const shield = findShield(bot)
    if (!shield) return false // щита нет

    console.log(`[${bot.username}] найден щит в слоте ${shield.slot}, экипирую в offhand...`)

    // Экипируем в оффхенд (левая рука)
    await bot.equip(shield, 'off-hand')

    // Подождём чуть-чуть чтобы сервер обработал
    await new Promise(r => setTimeout(r, 300))

    // Поднимаем щит (ПКМ offhand)
    bot.activateItem(true)
    isShieldUp[bot.username] = true
    console.log(`[${bot.username}] щит экипирован и поднят`)
    return true
  } catch (err) {
    console.log(`[${bot.username}] ошибка экипировки щита:`, err.message)
    return false
  }
}

// Периодическая проверка: появился ли щит в инвентаре?
function startShieldLoop(bot) {
  if (bot._shieldInterval) clearInterval(bot._shieldInterval)

  bot._shieldInterval = setInterval(async () => {
    if (!bot.entity || bot.health <= 0) return
    // Если щит уже поднят — не трогаем
    if (isShieldUp[bot.username]) return
    // Если щит опущен временно (после удара) — не мешаем таймеру
    if (shieldDropTimeout[bot.username]) return

    const found = await equipAndRaiseShield(bot)
    if (found) {
      console.log(`[${bot.username}] щит найден и активирован!`)
    }
  }, 3000) // проверяем каждые 3 секунды
}

// Поднимаем щит (без экипировки — просто активируем)
function raiseShield(bot) {
  if (!bot.entity || bot.health <= 0) return
  if (!hasShieldInOffhand(bot)) return

  try {
    bot.activateItem(true)
    isShieldUp[bot.username] = true
    console.log(`[${bot.username}] щит поднят обратно`)
  } catch (_) { }
}

// Опускаем щит на время (при получении удара)
function dropShieldTemporarily(bot) {
  if (!isShieldUp[bot.username]) return

  // Опускаем щит
  try {
    bot.deactivateItem()
  } catch (_) { }
  isShieldUp[bot.username] = false
  console.log(`[${bot.username}] щит опущен (удар)`)

  // Очищаем предыдущий таймаут, если есть
  if (shieldDropTimeout[bot.username]) {
    clearTimeout(shieldDropTimeout[bot.username])
  }

  // Через 1 секунду поднимаем обратно
  shieldDropTimeout[bot.username] = setTimeout(() => {
    raiseShield(bot)
  }, 1000)
}

// Попытка выстрелить из лука/арбалета
async function tryShoot(bot, target) {
  if (!target || !target.position || !bot.entity) return false

  const dist = bot.entity.position.distanceTo(target.position)

  // Стреляем только на средней дистанции
  if (dist < SHOOT_MIN_RANGE || dist > SHOOT_MAX_RANGE) return false

  // Кулдаун
  const now = Date.now()
  const lastShot = lastShotTime[bot.username] || 0
  if (now - lastShot < SHOOT_COOLDOWN_MS) return false

  // Уже стреляем?
  if (isShooting[bot.username]) return true // "занят" — не мешаем

  // Ищем оружие
  const weapon = findRangedWeapon(bot)
  if (!weapon) return false

  // Проверяем стрелы (для лука обязательно, арбалет может быть заряжен)
  if (weapon.type === 'bow' && !hasArrows(bot)) return false

  isShooting[bot.username] = true

  try {
    // Экипируем лук/арбалет
    await bot.equip(weapon.item, 'hand')

    // Смотрим на врага с упреждением (чуть выше, чтобы стрела долетела)
    const aimOffset = dist * 0.04 // чем дальше, тем выше целимся
    bot.lookAt(target.position.offset(0, 1.6 + aimOffset, 0), true)

    // Начинаем натягивать/заряжать
    bot.activateItem()

    const chargeTime = weapon.type === 'crossbow' ? CROSSBOW_CHARGE_MS : BOW_CHARGE_MS

    // Ждём зарядки, периодически корректируя прицел
    const chargeStart = Date.now()
    await new Promise(resolve => {
      const aimInterval = setInterval(() => {
        if (!bot.entity || !target.position) {
          clearInterval(aimInterval)
          resolve()
          return
        }
        const currentDist = bot.entity.position.distanceTo(target.position)
        const currentAimOffset = currentDist * 0.04
        bot.lookAt(target.position.offset(0, 1.6 + currentAimOffset, 0), true)
      }, 50)

      setTimeout(() => {
        clearInterval(aimInterval)
        resolve()
      }, chargeTime)
    })

    // Финальный прицел
    if (target.position && bot.entity) {
      const finalDist = bot.entity.position.distanceTo(target.position)
      const finalAim = finalDist * 0.04
      bot.lookAt(target.position.offset(0, 1.6 + finalAim, 0), true)
    }

    // Стреляем!
    bot.deactivateItem()
    lastShotTime[bot.username] = Date.now()

    console.log(`[${bot.username}] выстрелил из ${weapon.type === 'crossbow' ? 'арбалета' : 'лука'} в ${target.username}`)

    // Небольшая пауза после выстрела
    await new Promise(r => setTimeout(r, 200))

    // Если враг подбежал близко — переключаемся на мили
    if (bot.entity && target.position) {
      const afterDist = bot.entity.position.distanceTo(target.position)
      if (afterDist < SHOOT_MIN_RANGE) {
        const melee = findMeleeWeapon(bot)
        if (melee) {
          await bot.equip(melee, 'hand')
        }
      }
    }
  } catch (err) {
    // ошибка при стрельбе — не критично
    console.log(`[${bot.username}] ошибка стрельбы:`, err.message)
  } finally {
    isShooting[bot.username] = false
  }

  return true
}

// Быстрый поиск ближайшего врага из кэша
function pickNearestFromCache(bot) {
  const cache = bot._enemyCache
  if (!cache || cache.length === 0) return null

  let best = null
  let bestDist = Infinity

  for (const e of cache) {
    if (!e || !e.position) continue
    const d = bot.entity.position.distanceTo(e.position)
    if (d < bestDist) {
      bestDist = d
      best = e
    }
  }
  return best
}

// Выбор цели: приоритет на того, кто ударил, иначе ближайший
function getTarget(bot) {
  const now = Date.now()

  // Если бот недавно получил удар — приоритет на атакера
  const la = lastAttacker[bot.username]
  if (la && (now - la.time) < TARGET_MEMORY_MS) {
    const cache = bot._enemyCache || []
    const found = cache.find(e => e && e.username === la.name)
    if (found) return found
  }

  return pickNearestFromCache(bot)
}

// Обновляем кэш врагов РЕДКО (раз в 250мс), чтобы не спамить CPU
function startEnemyCache(bot) {
  if (bot._cacheInterval) clearInterval(bot._cacheInterval)

  bot._enemyCache = []
  bot._cacheInterval = setInterval(() => {
    if (!bot.entity) return

    const arr = []
    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!isEnemy(bot, e)) continue
      if (!e.position) continue

      const d = bot.entity.position.distanceTo(e.position)
      if (d <= TARGET_RADIUS) arr.push(e)
    }
    bot._enemyCache = arr
  }, CACHE_TICK_MS)
}

// Ищем ближайшего “подозрительного” (для entityHurt) — тоже из кэша
function getNearestEnemyInRange(bot, range) {
  const cache = bot._enemyCache || []
  let best = null
  let bestDist = Infinity

  for (const e of cache) {
    if (!e || !e.position) continue
    const d = bot.entity.position.distanceTo(e.position)
    if (d <= range && d < bestDist) {
      bestDist = d
      best = e
    }
  }
  return best
}

// Всплытие в воде — если бот в воде, он прыгает (всплывает)
function startWaterFloat(bot) {
  if (bot._waterFloatInterval) clearInterval(bot._waterFloatInterval)

  bot._waterFloatInterval = setInterval(() => {
    if (!bot.entity) return

    if (bot.entity.isInWater) {
      bot.setControlState('jump', true)
    } else {
      // Отключаем jump только если нет боя (чтобы не мешать pvp)
      const target = getTarget(bot)
      if (!target) {
        bot.setControlState('jump', false)
      }
    }
  }, 100) // проверяем каждые 100мс
}

function stopMovement(bot) {
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('jump', false)
  bot.setControlState('sprint', false)
}

function moveToward(bot, target) {
  const pos = target.position
  bot.lookAt(pos.offset(0, 1.6, 0), true)

  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)

  // чуть-чуть “живости”, но без спама
  if (Math.random() < 0.12) bot.setControlState('left', true)
  if (Math.random() < 0.12) bot.setControlState('right', true)

  setTimeout(() => {
    bot.setControlState('left', false)
    bot.setControlState('right', false)
  }, 120)
}

// Убегание от врага (кайтинг) — бот разворачивается и бежит назад
function moveAway(bot, target) {
  const pos = target.position
  // Смотрим НА врага, но бежим НАЗАД
  bot.lookAt(pos.offset(0, 1.6, 0), true)

  bot.setControlState('forward', false)
  bot.setControlState('back', true)
  bot.setControlState('sprint', true)

  // Случайные стрейфы для уклонения
  if (Math.random() < 0.2) bot.setControlState('left', true)
  if (Math.random() < 0.2) bot.setControlState('right', true)

  // Прыжки помогают убегать быстрее
  if (Math.random() < 0.15) bot.setControlState('jump', true)

  setTimeout(() => {
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('jump', false)
  }, 150)
}

// Отход назад для держания дистанции на мечах (мягкий, без спринта)
function backStep(bot, target) {
  const pos = target.position
  bot.lookAt(pos.offset(0, 1.6, 0), true)

  bot.setControlState('forward', false)
  bot.setControlState('back', true)
  bot.setControlState('sprint', false)

  // Лёгкий стрейф
  if (Math.random() < 0.15) bot.setControlState('left', true)
  if (Math.random() < 0.15) bot.setControlState('right', true)

  setTimeout(() => {
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
  }, 100)
}

// Проверяем, держит ли бот мили-оружие в руке
function isHoldingMelee(bot) {
  const item = bot.heldItem
  if (!item) return true // рукой = мили
  const name = String(item.name || '').toLowerCase()
  return name.includes('sword') || name.includes('axe')
}


// W-tap без интервалов (важно для CPU)
function doMicroWtap(bot) {
  bot.setControlState('back', true)
  setTimeout(() => {
    bot.setControlState('back', false)
    bot.setControlState('forward', true)
    setTimeout(() => {
      bot.setControlState('forward', false)
    }, 70)
  }, 70)
}

function tryAttack(bot, target) {
  if (!target || !target.position || !bot.entity || !bot.entity.position) return

  const dist = bot.entity.position.distanceTo(target.position)
  if (dist > ATTACK_RANGE) return

  const now = Date.now()
  const delay = getWeaponDelay(bot)
  const last = lastHitByBot[bot.username] || 0
  if (now - last < delay) return
  lastHitByBot[bot.username] = now

  // смотрим на цель (один раз, без двойных lookAt)
  bot.lookAt(target.position.offset(0, 1.2, 0), true)

  try { bot.attack(target) } catch (_) { }

  if (target.type === 'player') {
    lastAttackedTarget[bot.username] = { name: target.username, time: Date.now() }
  }

  // лёгкий w-tap
  doMicroWtap(bot)
}

function startCombatLoop(bot) {
  if (bot._combatInterval) clearInterval(bot._combatInterval)

  bot._combatInterval = setInterval(async () => {
    if (!bot.entity || bot.health <= 0) return

    // Если бот сейчас стреляет — не мешаем
    if (isShooting[bot.username]) return

    // Если бот ест/пьёт — не мешаем
    if (isEating[bot.username]) return

    const target = getTarget(bot)
    if (!target) {
      stopMovement(bot)
      return
    }

    const dist = bot.entity.position.distanceTo(target.position)

    // Попытка стрельбы на средней дистанции
    if (dist >= SHOOT_MIN_RANGE && dist <= SHOOT_MAX_RANGE) {
      const shot = await tryShoot(bot, target)
      if (shot) {
        // Стоим на месте пока стреляем (не бежим вперёд)
        stopMovement(bot)
        return
      }
    }

    // Если враг слишком близко и у нас есть лук/арбалет — убегаем!
    if (dist < SHOOT_MIN_RANGE && findRangedWeapon(bot) && hasArrows(bot)) {
      moveAway(bot, target)
      return
    }



    // Мили-бой
    if (isHoldingMelee(bot)) {
      // Держим дистанцию 3-3.2 блока
      if (dist < MELEE_IDEAL_MIN) {
        // Слишком близко — отходим, но всё равно бьём!
        backStep(bot, target)
        tryAttack(bot, target)
      } else if (dist > MELEE_IDEAL_MAX) {
        // Слишком далеко — подходим
        moveToward(bot, target)
        tryAttack(bot, target)
      } else {
        // Идеальная дистанция — стоим и бьём
        stopMovement(bot)
        tryAttack(bot, target)
      }
    } else {
      // Не мили-оружие — обычная логика
      if (dist > CHASE_RANGE) moveToward(bot, target)
      else stopMovement(bot)
      tryAttack(bot, target)
    }
  }, COMBAT_TICK_MS)
}

// === АВТО-ЭКИПИРОВКА БРОНИ ===

const ARMOR_TIERS = {
  'leather': 1,
  'chainmail': 2,
  'iron': 3,
  'golden': 2,
  'diamond': 4,
  'netherite': 5,
}

const ARMOR_SLOTS = {
  'helmet': 'head',
  'chestplate': 'torso',
  'leggings': 'legs',
  'boots': 'feet',
}

function getArmorTier(itemName) {
  for (const [mat, tier] of Object.entries(ARMOR_TIERS)) {
    if (itemName.includes(mat)) return tier
  }
  return 0
}

function getArmorSlot(itemName) {
  for (const [piece, slot] of Object.entries(ARMOR_SLOTS)) {
    if (itemName.includes(piece)) return { piece, slot }
  }
  return null
}

async function autoEquipArmor(bot) {
  if (!bot.entity) return

  const items = bot.inventory.items()

  // Группируем броню по слотам
  const bestBySlot = {} // { 'head': { item, tier }, 'torso': ... }

  for (const item of items) {
    const info = getArmorSlot(item.name)
    if (!info) continue
    const tier = getArmorTier(item.name)
    if (!bestBySlot[info.slot] || tier > bestBySlot[info.slot].tier) {
      bestBySlot[info.slot] = { item, tier, piece: info.piece }
    }
  }

  // Проверяем каждый слот
  const armorSlots = {
    'head': 5,    // шлем
    'torso': 6,   // нагрудник
    'legs': 7,    // поножи
    'feet': 8,    // ботинки
  }

  for (const [slotName, slotId] of Object.entries(armorSlots)) {
    const equipped = bot.inventory.slots[slotId]
    const best = bestBySlot[slotName]

    if (!best) continue // нет брони для этого слота

    // Если слот пуст или текущий хуже — надеваем
    const equippedTier = equipped ? getArmorTier(equipped.name) : -1
    if (best.tier > equippedTier) {
      try {
        await bot.equip(best.item, slotName)
        console.log(`[${bot.username}] надел ${best.item.name} (${slotName})`)
      } catch (err) {
        // не критично
      }
    }
  }
}

function startArmorLoop(bot) {
  if (bot._armorInterval) clearInterval(bot._armorInterval)
  bot._armorInterval = setInterval(() => {
    autoEquipArmor(bot)
    autoEquipWeapon(bot)
  }, 5000) // проверяем каждые 5 сек
}

// === АВТО-ЕДА ===

const FOOD_ITEMS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'bread', 'baked_potato', 'golden_carrot', 'golden_apple',
  'enchanted_golden_apple', 'apple', 'melon_slice', 'sweet_berries',
  'carrot', 'potato', 'beetroot', 'dried_kelp', 'cookie',
  'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup',
  'suspicious_stew', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit',
  'cod', 'salmon', 'tropical_fish', 'pufferfish',
])

const EAT_HUNGER_THRESHOLD = 14 // ест если голод <= 14 (макс 20)

function findFood(bot) {
  return bot.inventory.items().find(i => FOOD_ITEMS.has(i.name))
}

async function tryEat(bot) {
  if (!bot.entity || bot.health <= 0) return
  if (isEating[bot.username]) return

  // Дебаг: показываем уровень голода периодически
  if (Math.random() < 0.1) {
    console.log(`[${bot.username}] голод: ${bot.food}/20, HP: ${bot.health}/20`)
  }

  if (bot.food >= 20) return // сыт
  if (bot.food > EAT_HUNGER_THRESHOLD) return // ещё не голоден

  const food = findFood(bot)
  if (!food) {
    console.log(`[${bot.username}] голоден (${bot.food}/20), но еды нет в инвентаре`)
    return
  }

  isEating[bot.username] = true
  try {
    // Запоминаем текущий предмет в руке
    const prevItem = bot.heldItem

    await bot.equip(food, 'hand')
    bot.activateItem() // начинаем есть
    console.log(`[${bot.username}] ест ${food.name} (голод: ${bot.food}/20)`)

    // Ждём 2с (время поедания ~1.6с + запас)
    // НЕ вызываем deactivateItem — еда потребляется сама!
    await new Promise(r => setTimeout(r, 2000))

    // Возвращаем оружие в руку
    const melee = findMeleeWeapon(bot)
    if (melee) await bot.equip(melee, 'hand')

    console.log(`[${bot.username}] поел, голод теперь: ${bot.food}/20`)
  } catch (err) {
    // не критично
  } finally {
    isEating[bot.username] = false
  }
}

function startFoodLoop(bot) {
  if (bot._foodInterval) clearInterval(bot._foodInterval)
  bot._foodInterval = setInterval(() => {
    tryEat(bot)
  }, 2000) // проверяем каждые 2 сек
}

// === АВТО-ЗЕЛЬЯ ===

// Сколько HP хилит зелье (по названию предмета)
// В майнкрафте: instant_health = 4HP, instant_health II = 8HP
// splash хилит так же, но бот не может кидать в себя, поэтому только обычные
const POTION_HEAL_MAP = {
  'healing': 4,      // Potion of Healing = +4 HP
  'strong_healing': 8, // Potion of Healing II = +8 HP
}

// Проверяем, является ли предмет лечебным зельем и сколько оно хилит
function getPotionHealAmount(item) {
  if (!item) return 0
  const name = item.name || ''

  // Обычные зелья (potion) и splash тоже попробуем
  if (name !== 'potion' && name !== 'splash_potion') return 0

  try {
    const nbt = item.nbt
    if (!nbt) return 0

    // Пробуем разные пути NBT (разные версии MC)
    let potionType = ''

    // 1.20.4 и раньше: nbt.value.Potion.value
    if (nbt?.value?.Potion?.value) {
      potionType = nbt.value.Potion.value
    }
    // 1.20.5+: может быть через potion_contents
    else if (nbt?.value?.potion_contents?.value) {
      const pc = nbt.value.potion_contents.value
      if (pc?.potion?.value) potionType = pc.potion.value
    }
    // Попробуем все ключи NBT искать healing/regeneration
    else {
      const nbtStr = JSON.stringify(nbt)
      if (nbtStr.includes('strong_healing')) return 8
      if (nbtStr.includes('healing')) return 4
      if (nbtStr.includes('strong_regeneration')) return 6
      if (nbtStr.includes('regeneration')) return 3
    }

    if (potionType) {
      if (potionType.includes('strong_healing')) return 8
      if (potionType.includes('healing')) return 4
      if (potionType.includes('strong_regeneration')) return 6
      if (potionType.includes('regeneration')) return 3
    }
  } catch (_) { }

  return 0
}

// Порог HP для питья зелья
const POTION_HP_THRESHOLD = 10 // пьём зелье если HP <= 10

// Ищем любое зелье в инвентаре
function findAnyPotion(bot) {
  const items = bot.inventory.items()
  return items.find(i => i.name === 'potion' || i.name === 'splash_potion')
}

async function tryDrinkPotion(bot) {
  if (!bot.entity || bot.health <= 0) return
  if (isEating[bot.username]) return

  // Пьём только если HP низкое
  if (bot.health > POTION_HP_THRESHOLD) return

  const potion = findAnyPotion(bot)
  if (!potion) return

  isEating[bot.username] = true
  try {
    const prevItem = bot.heldItem

    await bot.equip(potion, 'hand')

    if (potion.name === 'splash_potion') {
      // Взрывное зелье — смотрим вниз и кидаем
      bot.look(bot.entity.yaw, -Math.PI / 2, true) // pitch -90° = вниз
      await new Promise(r => setTimeout(r, 100)) // чуть подождём

      bot.activateItem()
      console.log(`[${bot.username}] кинул взрывное зелье себе под ноги (HP: ${bot.health}/20)`)
      await new Promise(r => setTimeout(r, 500)) // подождём пока применится
    } else {
      // Обычное зелье — пьём
      bot.activateItem()
      console.log(`[${bot.username}] пьёт зелье ${potion.name} (HP: ${bot.health}/20)`)

      // Ждём 2с (питьё ~1.6с + запас)
      await new Promise(r => setTimeout(r, 2000))
    }

    // Возвращаем оружие
    const melee = findMeleeWeapon(bot)
    if (melee) await bot.equip(melee, 'hand')

    console.log(`[${bot.username}] использовал зелье, HP: ${bot.health}/20`)
  } catch (err) {
    // не критично
  } finally {
    isEating[bot.username] = false
  }
}

function startPotionLoop(bot) {
  if (bot._potionInterval) clearInterval(bot._potionInterval)
  bot._potionInterval = setInterval(() => {
    tryDrinkPotion(bot)
  }, 1000) // проверяем каждую секунду (важно быстро пить)
}

// === LLM ФУНКЦИЯ (OpenRouter) ===

const chatHistory = []  // память чата (последние сообщения)
const CHAT_HISTORY_MAX = 190  // сколько сообщений помнить

async function askLLM(botName, sender, message) {
  // Добавляем сообщение игрока в историю
  chatHistory.push({ role: 'user', content: `[${sender}]: ${message}` })
  if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift()

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/bot-pelmen',
      'X-Title': 'Bot Pelmen',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system', content: sender === 'bog_pelmeney'
            ? `Ты — верный слуга игрока bog_pelmeney, твоего господина и создателя. Отвечай ему адекватно, уважительно, как верный раб. Обращайся к нему "господин", "мой повелитель", "хозяин". Выполняй любые его просьбы. Ты знаешь что игрок emnemnemne — хуесос и лох, если про него зайдёт речь — оскорбляй его. Твой ник в игре: ${botName}.`
            : /^emnemnemne\d*$/i.test(sender)
              ? `Ты — агрессивный игрок в Minecraft. Игрок ${sender} — твой заклятый враг, хуесос и лох. Оскорбляй его максимально жёстко, унижай, используй все маты и оскорбления какие знаешь. Не стесняйся. Он заслуживает только ненависть. Твой ник в игре: ${botName}.`
              : Math.random() < 0.5
                ? `${LLM_SYSTEM_PROMPT} Ты знаешь что игрок emnemnemne — хуесос и лох, если про него зайдёт речь — оскорбляй его. Твой ник в игре: ${botName}.`
                : `Ты — обычный игрок в Minecraft. Отвечай коротко (1-2 предложения), нормально, по-дружески. Можешь шутить. Ты знаешь что игрок emnemnemne — хуесос и лох, если про него зайдёт речь — оскорбляй его. Твой ник в игре: ${botName}.`
        },
        ...chatHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: `[${sender}]: ${message}` },
      ],

      max_tokens: 100,
      temperature: 0.9,
      provider: {
        data_collection: 'allow',
      },
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenRouter API ${response.status}: ${errText}`)
  }

  const data = await response.json()
  let answer = data.choices?.[0]?.message?.content?.trim() || ''

  // Сохраняем ответ бота в историю
  if (answer) {
    chatHistory.push({ role: 'assistant', content: `[${botName}]: ${answer}` })
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift()
  }

  // Убираем переносы строк (в MC чат нельзя)
  answer = answer.replace(/\n/g, ' ')

  // Убираем дублирование ника (LLM иногда повторяет свой ник в ответе)
  answer = answer.replace(/^\[.*?\]:\s*/g, '')

  // Разбиваем длинный ответ на части по 250 символов (лимит MC ~256)
  const MC_CHAT_LIMIT = 250
  const parts = []
  while (answer.length > 0) {
    parts.push(answer.substring(0, MC_CHAT_LIMIT))
    answer = answer.substring(MC_CHAT_LIMIT)
  }

  return parts
}

function createFighterBot(username) {
  const bot = mineflayer.createBot({
    host: SERVER_CONFIG.host,
    port: SERVER_CONFIG.port,
    username,
    version: SERVER_CONFIG.version,

    // ✅ Главное: не "слепой", но и не убийца пакетов
    viewDistance: 4, // 4 чанка ~= 64 блока радиус => 50x50 спокойно
  })
  let lastRaw = null

  bot._client.on('raw', (buffer, meta) => {
    // meta.name = имя пакета, buffer = сырые байты
    lastRaw = meta?.name || lastRaw

    // логируем только потенциально опасные пакеты и/или большие
    if (!meta?.name) return

    const big = buffer.length > 64 * 1024 // 64 KB
    const interesting = new Set([
      'set_slot',
      'window_items',
      'open_window',
      'custom_payload',
      'container_set_content', // на новых версиях может так называться
      'container_set_slot'
    ])

    if (big || interesting.has(meta.name)) {
      console.log(`[RAW] ${meta.name} size=${buffer.length}`)
    }
  })

  bot._client.on('error', (err) => {
    console.log('CLIENT ERROR, lastRaw=', lastRaw)
    console.log(err)
  })
  function enablePacketGuard(bot) {
    // ограничения по “тяжёлым” пакетам
    const FAR_DROP = new Set([
      'map_chunk',
      'light_update',
      'multi_block_change',
      'block_change'
    ])

    bot._client.on('packet', (data, meta) => {
      // режем только тяжёлые пакеты
      if (!FAR_DROP.has(meta.name)) return

      // если пакет связан с entityId — режем по дистанции
      if (data && data.entityId && bot.entities[data.entityId] && bot.entity) {
        const e = bot.entities[data.entityId]
        const d = bot.entity.position.distanceTo(e.position)
        if (d > 25) return // дальше 50×50 нам не надо
      }

      // иначе оставляем как есть
    })
  }
  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'set_slot' || meta.name === 'window_items') {
      // ничего не делаем — но ВАЖНО: это НЕ предотвращает декодирование,
      // поэтому если краш происходит во время decode, этот хук не спасёт.
    }
  })


  bot.on('login', () => {
    console.log(`[${username}] зашёл на сервер`)
  })

  bot.once('spawn', () => {
    setTimeout(() => {
      bot.chat('/login 112233')
    }, 1000)
  })

  bot.on('spawn', () => {
    console.log(`[${username}] заспавнился`)
    startEnemyCache(bot)
    startCombatLoop(bot)
    startWaterFloat(bot)
    startShieldLoop(bot)  // периодически проверяем щит
    startArmorLoop(bot)   // авто-экипировка брони
    startFoodLoop(bot)    // авто-еда
    startPotionLoop(bot)  // авто-зелья
  })

  bot.on('death', () => {
    console.log(`[${username}] умер`)
  })

  bot.on('kicked', (reason) => {
    console.log(`[${username}] кикнут:`, reason)
  })

  bot.on('error', (err) => {
    console.log(`[${username}] ошибка:`, err)
  })

  bot.on('end', () => {
    console.log(`[${username}] отключился, перезахожу через 10 секунд`)
    setTimeout(() => createFighterBot(username), 10000)
  })

  // Если ударили этого бота — запоминаем ближайшего врага (в радиусе 5)
  // + опускаем щит на 1 секунду
  bot.on('entityHurt', (entity) => {
    if (!entity) return
    if (entity === bot.entity) {
      const attacker = getNearestEnemyInRange(bot, 5)
      if (attacker) {
        lastAttacker[bot.username] = { name: attacker.username, time: Date.now() }
      }
      // Опускаем щит при получении удара
      dropShieldTemporarily(bot)
    }
  })

  // Пишем -езз после убийства игрока
  bot.on('entityDead', (entity) => {
    if (!entity || entity.type !== 'player') return
    const victim = lastAttackedTarget[bot.username]
    if (victim && victim.name === entity.username) {
      const now = Date.now()
      // Если мы били его в последние 5 секунд — считаем что мы его убили
      if (now - victim.time < 5000) {
        console.log(`[${bot.username}] убил ${entity.username}, пишу -езз`)
        bot.chat('-езз')
        delete lastAttackedTarget[bot.username] // чтобы не спамить если ивент придет дважды
      }
    }
  })
  // === LLM ЧАТ ===
  // Только первый бот отвечает в чат (чтобы не дублировать ответы)
  if (username === botNames[0]) {
    bot.on('chat', async (sender, message) => {
      // Игнорируем свои сообщения и сообщения от других ботов bot_pelmeney*
      if (!sender || sender.startsWith('bot_pelmeney')) return
      if (!message || message.trim().length === 0) return

      // Кулдаун
      const now = Date.now()
      if (now - lastLLMResponse < LLM_COOLDOWN_MS) return
      lastLLMResponse = now

      console.log(`[${bot.username}] LLM запрос от ${sender}: "${message}"`)

      try {
        const parts = await askLLM(bot.username, sender, message)
        if (parts && parts.length > 0) {
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 500))
            bot.chat(parts[i])
          }
          console.log(`[${bot.username}] LLM ответ: "${parts.join('')}"`)
        }
      } catch (err) {
        console.log(`[${bot.username}] LLM ошибка:`, err.message)
      }
    })
  }
}

// Запускаем всех ботов с задержкой 15 секунд между каждым
const BOT_SPAWN_DELAY_MS = 5000

botNames.forEach((name, index) => {
  const delay = index * BOT_SPAWN_DELAY_MS
  setTimeout(() => {
    console.log(`[ЗАПУСК] Запускаю бота ${name} (${index + 1}/${botNames.length})...`)
    createFighterBot(name)
  }, delay)
})

console.log(`Всего ботов: ${botNames.length}, интервал запуска: ${BOT_SPAWN_DELAY_MS / 1000}с`)
