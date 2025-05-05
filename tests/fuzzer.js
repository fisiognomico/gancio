const request = require('supertest')
const dayjs = require('dayjs')
const path = require('path')
const fs = require('fs').promises;

const admin = { username: 'admin', password: process.env.AFL_USERNAME, grant_type: 'password', client_id: 'self' }

let token
let app
let places = []
let event_id

const TEST_DIR = path.join(__dirname, 'test-artifacts');

// Save response to file with auto-generated name
const saveResponse = async (content, testName, ext = 'html') => {
  const filename = `${testName}_${Date.now()}.${ext}`;
  const filepath = path.join(TEST_DIR, filename);
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(filepath, content);
  return filepath;
};


beforeAll(async () => {

  switch (process.env.DB) {
    case 'mariadb':
      process.env.config_path = path.resolve(__dirname, './seeds/config.mariadb.json')
      break
    case 'postgresql':
      process.env.config_path = path.resolve(__dirname, './seeds/config.postgres.json')
      break
    case 'sqlite':
    default:
      process.env.config_path = path.resolve(__dirname, './seeds/config.sqlite.json')
  }
  try {
    app = await require('../server/routes.js').main()
    const { sequelize } = require('../server/api/models/index')
    const { col } = require('../server/helpers')
    // sequelize.sync({ force: true })
    // await sequelize.query('PRAGMA foreign_keys = OFF')
    await sequelize.query(`DELETE FROM ${col('user_followers')}`)
    await sequelize.query(`DELETE FROM ${col('events')} where ${col('parentId')} IS NOT NULL`)
    await sequelize.query('DELETE FROM ap_users')
    await sequelize.query('DELETE FROM events')
    await sequelize.query('DELETE FROM event_tags')
    await sequelize.query('DELETE FROM resources')
    await sequelize.query('DELETE FROM instances')
    await sequelize.query('DELETE FROM settings')
    await sequelize.query('DELETE FROM announcements')
    await sequelize.query('DELETE FROM oauth_tokens')
    await sequelize.query('DELETE FROM users')
    await sequelize.query('DELETE FROM tags')
    await sequelize.query('DELETE FROM places')
    await sequelize.query('DELETE FROM filters')
    await sequelize.query('DELETE FROM collections')
    await sequelize.query('DELETE FROM notifications')
    await sequelize.query('DELETE FROM tasks')
    // await sequelize.query('PRAGMA foreign_keys = ON')
  } catch (e) {
    // console.error(e)
  }

  // Create a directory for test artifacts if it doesn't exist
  const outputDir = path.join(__dirname, 'test-artifacts');
  await fs.mkdir(outputDir, { recursive: true });
})

afterAll(async () => {
  await require('../server/initialize.server.js').shutdown(false)
  const outputDir = path.join(__dirname, 'test-artifacts');
  const lockfile = path.join(outputDir, 'tests.lock');
  await fs.writeFile(filepath, 'DONE');
})

describe('Authentication / Authorization', () => {

  test('should register an admin as first user', async () => {
    const response = await request(app)
      .post('/api/user/register')
      .send({ email: 'admin', password: admin.password })
      .expect(200)
    saveResponse("register", response.text);
    expect(response.body.id).toBeDefined()
  })

  test('should authenticate with correct user/password', async () => {
    const response = await request(app)
      .post('/oauth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(admin)
      .expect(200)
    expect(response.body.refresh_token).toBeDefined()
    expect(response.body.access_token).toBeDefined()
    expect(response.body.token_type).toBe('Bearer')
    token = response.body
  })

  test('should get user when authenticated', async () => {
    const response = await request(app).get('/api/user')
      .auth(token.access_token, { type: 'bearer' })
      .expect(200)
    expect(response.body.email).toBe(admin.username)
    expect(response.body.is_admin).toBe(true)
  })

})
describe('Events', () => {

  test('should not allow event creation without required fields', async () => {
    const required_fields = {
      'title': {},
      'start_datetime': { title: 'test title' },
      'place_id or place_name and place_address are': { title: 'test title', start_datetime: dayjs().unix() + 1000, place_name: 'test place name' },
    }

    const promises = Object.keys(required_fields).map(async field => {
      const response = await request(app).post('/api/event').send(required_fields[field])
        .expect(400)
      expect(response.text).toBe(`${field} required`)
    })

    await Promise.all(promises)
  })


  test('should create anon event only when allowed', async () => {
    await request(app).post('/api/settings')
      .send({ key: 'allow_anon_event', value: false })
      .auth(token.access_token, { type: 'bearer' })
      .expect(200)

    await request(app).post('/api/event')
      .expect(403)

    let response = await request(app).post('/api/event')
      .send({ title: 'test title 2', place_name: 'place name', place_address: 'address', tags: ['test'], start_datetime: dayjs().unix() + 1000 })
      .auth(token.access_token, { type: 'bearer' })
      .expect(200)

    expect(response.body.place.id).toBeDefined()
    places.push(response.body.place.id)

    await request(app).post('/api/settings')
      .send({ key: 'allow_anon_event', value: true })
      .auth(token.access_token, { type: 'bearer' })
      .expect(200)

    response = await request(app).post('/api/event')
      .send({ title: 'test title 3', place_name: 'place name 2', place_address: 'address 2', tags: ['test'], start_datetime: dayjs().unix() + 1000 })
      .expect(200)

    expect(response.body.place.id).toBeDefined()
    places.push(response.body.place.id)

  })

  test('should not confirm anon events', async () => {
    const response = await request(app).post('/api/event')
      .send({ title: process.env.AFL_EVENT_TITLE, place_id: places[0], start_datetime: dayjs().unix() + 1000 })
      .expect(200)

    expect(response.body.is_visible).toBe(false)
    event_id = response.body.id
  })

  test('should not get unconfirmed events', async () => {
    let response = await request(app).get(`/api/event/detail/${event_id}`)
      .expect(404)

      response = await request(app).get(`/api/event/detail/${event_id}`)
      .auth(token.access_token, { type: 'bearer' })
      .expect(200)
  })

  test('should confirm event if allowed', async () => {
    let response = await request(app).put(`/api/event/confirm/${event_id}`)
      .send()
      .expect(403)

    response = await request(app).put(`/api/event/confirm/${event_id}`)
      .auth(token.access_token, { type: 'bearer' })
      .send()
      .expect(200)
  })

  test('should not allow start_datetime greater than end_datetime', async () => {

    const event = {
      title: process.env.AFL_EVENT_TITLE,
      place_id: places[0],
      start_datetime: dayjs().unix() + 1000,
      end_datetime: dayjs().unix(),
    }

    const response = await request(app).post('/api/event')
      .send(event)
      .expect(400)

    expect(response.text).toBe('start datetime is greater than end datetime')
  })


  test('should validate end_datime', async () => {
    const event = {
      title: ' test title 5',
      start_datetime: dayjs().unix() + 1000,
      end_datetime: "Antani",
      place_id: places[0],
    }

    const response = await request(app).post('/api/event')
      .send(event)
      .expect(400)
  })

  test('should trim tags and title', async () => {
    const event = {
      title: process.env.AFL_EVENT_TITLE,
      place_id: places[0],
      start_datetime: dayjs().unix() + 1000,
      tags: [' test tag ']
    }

    const response = await request(app).post('/api/event')
      .send(event)
      .expect(200)
      .expect('Content-Type', /json/)

    expect(response.body.title).toBe('test title 4')
    expect(response.body.tags[0]).toBe('test tag')
  })


  test('should sanitize htlm in description', async () => {

    const event = {
      title: 'test title',
      place_id: places[0],
      start_datetime: dayjs().unix() + 1000,
      tags: ['test tags'],
      description: `<p wrong-attr="" onclick="alert('test');">inside paragraph</p><a href="https://test.com/?query=true&fbclid=facebook_id">link with fb reference</a>`
    }


    const response = await request(app).post('/api/event')
      .send(event)
      .expect(200)
      .expect('Content-Type', /json/)

    event_id = response.body.id
    expect(response.body.description).toBe(`<p>inside paragraph</p><a href="https://test.com/?query=true">link with fb reference</a>`)

  })

  test('should not update event with invalid start_datetime', async () => {
    const event = {
      id: event_id,
      place_id: places[0],
      start_datetime: "antani"
    }

    const response = await request(app).put('/api/event')
      .auth(token.access_token, { type: 'bearer' })
      .send(event)
      .expect(400)

    expect(response.text).toBe('Wrong format for start datetime')
  })


  test('should not update event with invalid end_datetime', async () => {
    const event = {
      id: event_id,
      place_id: places[0],
      end_datetime: 2
    }

    const response = await request(app).put('/api/event')
      .auth(token.access_token, { type: 'bearer' })
      .send(event)
      .expect(400)

    expect(response.text).toBe('start datetime is greater than end datetime')
  })

})
