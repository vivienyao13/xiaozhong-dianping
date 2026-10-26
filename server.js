const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 对 HTML 文件禁止缓存
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }
}));

// PostgreSQL 连接池（配置来自 .env / 环境变量）
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'xiaozhong_dianping'
});

// ========== 小众点评 API ==========

// 初始化表（首次启动自动建表）
async function initTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS xz_dishes (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        restaurant VARCHAR(500),
        rating INTEGER DEFAULT 0,
        tags VARCHAR(500),
        photo TEXT,
        date VARCHAR(20),
        price NUMERIC,
        review TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    console.log('✅ 小众点评表初始化完成');
  } catch (err) {
    console.error('❌ 小众点评表初始化失败:', err.message);
  }
}

// 菜品统计
app.get('/api/dishes/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as count FROM xz_dishes');
    const thisMonth = await pool.query('SELECT COUNT(*) as count FROM xz_dishes WHERE date LIKE $1', [new Date().toISOString().slice(0, 7)]);
    const avgPrice = await pool.query('SELECT AVG(price) as avg FROM xz_dishes WHERE price IS NOT NULL');

    res.json({
      total: parseInt(total.rows[0].count),
      thisMonth: parseInt(thisMonth.rows[0].count),
      avgPrice: avgPrice.rows[0].avg ? Math.round(avgPrice.rows[0].avg * 100) / 100 : 0
    });
  } catch (err) {
    console.error('获取统计失败:', err.message);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// 获取所有菜品（支持 search/tag/date 查询参数）
app.get('/api/dishes', async (req, res) => {
  try {
    const { search, tag, date } = req.query;
    let sql = 'SELECT * FROM xz_dishes WHERE 1=1';
    const params = [];

    if (search) {
      const base = params.length;
      sql += ' AND (name LIKE $' + (base + 1) + ' OR restaurant LIKE $' + (base + 2) + ' OR review LIKE $' + (base + 3) + ')';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (tag) {
      sql += ' AND tags LIKE $' + (params.length + 1);
      params.push(`%${tag}%`);
    }

    if (date) {
      sql += ' AND date LIKE $' + (params.length + 1);
      params.push(date + '%');
    }

    sql += ' ORDER BY date DESC, created_at DESC';

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('获取菜品失败:', err.message);
    res.status(500).json({ error: '获取菜品失败' });
  }
});

// 菜品导出（必须放在 /:id 之前，否则会被当成 id=export）
app.get('/api/dishes/export', async (req, res) => {
  try {
    const dishes = await pool.query('SELECT * FROM xz_dishes ORDER BY date DESC');
    res.json({ dishes: dishes.rows });
  } catch (err) {
    console.error('导出失败:', err.message);
    res.status(500).json({ error: '导出失败' });
  }
});

// 获取单个菜品
app.get('/api/dishes/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM xz_dishes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '菜品不存在' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('获取菜品失败:', err.message);
    res.status(500).json({ error: '获取菜品失败' });
  }
});

// 创建菜品
app.post('/api/dishes', async (req, res) => {
  try {
    const { id, name, restaurant, rating, tags, photo, date, price, review } = req.body;
    const now = Date.now();
    const dishId = id || 'dish-' + now + '-' + Math.random().toString(36).substr(2, 9);

    const result = await pool.query(
      `INSERT INTO xz_dishes (id, name, restaurant, rating, tags, photo, date, price, review, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [dishId, name, restaurant || '', rating || 0, tags || '', photo || null, date || new Date().toISOString().split('T')[0], price ? parseFloat(price) : null, review || '', now, now]
    );

    res.json({ success: true, dish: result.rows[0] });
  } catch (err) {
    console.error('创建菜品失败:', err.message);
    res.status(500).json({ error: '创建菜品失败' });
  }
});

// 更新菜品
app.put('/api/dishes/:id', async (req, res) => {
  try {
    const { name, restaurant, rating, tags, photo, date, price, review } = req.body;
    const now = Date.now();

    const result = await pool.query(
      `UPDATE xz_dishes
       SET name = COALESCE($1, name),
           restaurant = COALESCE($2, restaurant),
           rating = COALESCE($3, rating),
           tags = COALESCE($4, tags),
           photo = COALESCE($5, photo),
           date = COALESCE($6, date),
           price = COALESCE($7, price),
           review = COALESCE($8, review),
           updated_at = $9
       WHERE id = $10
       RETURNING *`,
      [name, restaurant, rating, tags, photo, date, price ? parseFloat(price) : null, review, now, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '菜品不存在' });
    }

    res.json({ success: true, dish: result.rows[0] });
  } catch (err) {
    console.error('更新菜品失败:', err.message);
    res.status(500).json({ error: '更新菜品失败' });
  }
});

// 删除菜品
app.delete('/api/dishes/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM xz_dishes WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '菜品不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('删除菜品失败:', err.message);
    res.status(500).json({ error: '删除菜品失败' });
  }
});

// 菜品导入
app.post('/api/dishes/import', async (req, res) => {
  try {
    const { dishes } = req.body;
    let success = 0;

    if (dishes && Array.isArray(dishes)) {
      for (const dish of dishes) {
        await pool.query(
          `INSERT INTO xz_dishes (id, name, restaurant, rating, tags, photo, date, price, review, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE SET name = $2, restaurant = $3, rating = $4, tags = $5, photo = $6, date = $7, price = $8, review = $9, created_at = $10, updated_at = $11`,
          [dish.id, dish.name, dish.restaurant || '', dish.rating || 0, dish.tags || '', dish.photo || null, dish.date || null, dish.price ? parseFloat(dish.price) : null, dish.review || '', dish.createdAt || Date.now(), dish.updatedAt || Date.now()]
        );
        success++;
      }
    }

    res.json({ success: true, imported: success });
  } catch (err) {
    console.error('导入失败:', err.message);
    res.status(500).json({ error: '导入失败：' + err.message });
  }
});

// 启动服务器
app.listen(PORT, '0.0.0.0', async () => {
  await initTables();
  console.log(`🚀 小众点评服务已启动`);
  console.log(`📱 打开浏览器访问: http://localhost:${PORT}/xiaozhong.html`);
});
