// src/routes/finance.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess, requireProPlan } = require('../middleware/auth');

function periodSql(period, dateColumn, params) {
  if (period === 'today') {
    params.push(new Date().toISOString().slice(0, 10));
    return ` AND ${dateColumn} = $${params.length}`;
  }
  if (period === 'week') {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    params.push(d.toISOString().slice(0, 10));
    return ` AND ${dateColumn} >= $${params.length}`;
  }
  if (period === 'month' || !period) {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    params.push(first);
    return ` AND ${dateColumn} >= $${params.length}`;
  }
  return '';
}

async function hasColumn(table, column) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasTable(table) {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS name`, [`public.${table}`]);
  return Boolean(rows[0]?.name);
}

// GET /api/salons/:salonId/expenses
router.get(['/:salonId/expenses','/:salonId/finance/expenses'], requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { salonId } = req.params;
    const { period } = req.query;
    const params = [salonId];
    let where = `WHERE salon_id = $1`;
    where += periodSql(period, 'expense_date', params);

    const { rows } = await pool.query(
      `SELECT id, salon_id, type, category, subcategory, amount, expense_date, description, receipt_img, staff_id, created_at
       FROM expenses
       ${where}
       ORDER BY expense_date DESC, created_at DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('GET expenses error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/salons/:salonId/expenses
router.post(['/:salonId/expenses','/:salonId/finance/expenses'], requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { salonId } = req.params;
    const {
      type,
      category,
      subcategory,
      amount,
      expense_date,
      expenseDate,
      description,
      receipt_img,
      receiptImg,
      staff_id,
      staffId
    } = req.body;

    const finalAmount = Number(amount);
    if (!finalAmount || finalAmount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    const finalType = type || category || 'Autre';
    const finalCategory = category || type || 'Autre';
    const finalDate = expense_date || expenseDate || new Date().toISOString().slice(0, 10);
    const finalStaffId = staff_id || staffId || null;

    const { rows } = await pool.query(
      `INSERT INTO expenses (
        salon_id,
        type,
        category,
        subcategory,
        amount,
        expense_date,
        description,
        receipt_img,
        staff_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        salonId,
        finalType,
        finalCategory,
        subcategory || '',
        finalAmount,
        finalDate,
        description || '',
        receipt_img || receiptImg || null,
        finalStaffId
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST expenses error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/salons/:salonId/expenses/:expenseId
router.delete(['/:salonId/expenses/:expenseId','/:salonId/finance/expenses/:expenseId'], requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { salonId, expenseId } = req.params;
    const { rowCount } = await pool.query(
      `DELETE FROM expenses WHERE salon_id = $1 AND id = $2`,
      [salonId, expenseId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    console.error('DELETE expenses error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/salons/:salonId/finance/summary?period=month|week|today|all
router.get('/:salonId/finance/summary', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { salonId } = req.params;
    const { period = 'month' } = req.query;

    const revenueParams = [salonId];
    let revenueWhere = `WHERE salon_id = $1 AND status = 'done'`;
    revenueWhere += periodSql(period, 'appt_date', revenueParams);

    const expenseParams = [salonId];
    let expenseWhere = `WHERE salon_id = $1`;
    expenseWhere += periodSql(period, 'expense_date', expenseParams);

    const revenueRes = await pool.query(
      `SELECT
        COALESCE(SUM(total),0) AS revenue,
        COUNT(*) AS appointments
       FROM appointments
       ${revenueWhere}`,
      revenueParams
    );

    const expenseRes = await pool.query(
      `SELECT
        COALESCE(SUM(amount),0) AS expenses
       FROM expenses
       ${expenseWhere}`,
      expenseParams
    );

    const expenseByTypeRes = await pool.query(
      `SELECT type, COALESCE(SUM(amount),0) AS total
       FROM expenses
       ${expenseWhere}
       GROUP BY type
       ORDER BY total DESC`,
      expenseParams
    );

    const appointmentHasStaff = await hasColumn('appointments', 'staff_id');
    const staffTableExists = await hasTable('staff');

    let staffRows = [];
    if (appointmentHasStaff && staffTableExists) {
      const staffParams = [salonId];
      let staffWhere = `WHERE a.salon_id = $1 AND a.status = 'done'`;
      staffWhere += periodSql(period, 'a.appt_date', staffParams);
      const staffRes = await pool.query(
        `SELECT
          COALESCE(st.name, 'Non assigné') AS staff_name,
          COUNT(a.id) AS appointments,
          COALESCE(SUM(a.total),0) AS revenue,
          COALESCE(MAX(st.commission_rate), 0.30) AS commission_rate
         FROM appointments a
         LEFT JOIN staff st ON st.id = a.staff_id
         ${staffWhere}
         GROUP BY COALESCE(st.name, 'Non assigné')
         ORDER BY revenue DESC`,
        staffParams
      );
      staffRows = staffRes.rows;
    } else {
      staffRows = [{
        staff_name: 'Non assigné',
        appointments: Number(revenueRes.rows[0].appointments || 0),
        revenue: Number(revenueRes.rows[0].revenue || 0),
        commission_rate: 0
      }];
    }

    const staff = staffRows.map(row => {
      const revenue = Number(row.revenue || 0);
      const rate = Number(row.commission_rate || 0);
      const commission = revenue * rate;
      return {
        name: row.staff_name,
        staffName: row.staff_name,
        appointments: Number(row.appointments || 0),
        count: Number(row.appointments || 0),
        revenue,
        commissionRate: rate,
        commission,
        net: revenue - commission,
        salonNet: revenue - commission
      };
    });

    const revenue = Number(revenueRes.rows[0].revenue || 0);
    const expenses = Number(expenseRes.rows[0].expenses || 0);
    const commissions = staff.reduce((sum, s) => sum + Number(s.commission || 0), 0);
    const profit = revenue - expenses - commissions;

    res.json({
      period,
      summary: {
        revenue,
        expenses,
        commissions,
        profit,
        margin: revenue ? Math.round((profit / revenue) * 100) : 0,
        appointments: Number(revenueRes.rows[0].appointments || 0)
      },
      staff,
      expensesByType: expenseByTypeRes.rows.map(r => ({ type: r.type, total: Number(r.total || 0) }))
    });
  } catch (err) {
    console.error('GET finance summary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
