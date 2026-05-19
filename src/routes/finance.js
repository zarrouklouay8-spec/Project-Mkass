// src/routes/finance.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess } = require('../middleware/auth');

function getPeriodRange(period) {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (period === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  if (period === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  if (period === 'all') {
    return { start: null, end: null };
  }

  // Default: current month
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function addDateFilter(params, fieldName, period) {
  const { start, end } = getPeriodRange(period);
  if (!start || !end) return '';
  params.push(start, end);
  const startIndex = params.length - 1;
  const endIndex = params.length;
  return ` AND ${fieldName} BETWEEN $${startIndex} AND $${endIndex}`;
}

// GET /api/salons/:salonId/finance/summary?period=today|week|month|all
router.get('/:salonId/finance/summary', requireSalonAccess, async (req, res) => {
  try {
    const { salonId } = req.params;
    const period = req.query.period || 'month';

    const apptParams = [salonId];
    const apptDateFilter = addDateFilter(apptParams, 'a.appt_date', period);

    const revenueRes = await pool.query(
      `SELECT COALESCE(SUM(a.total), 0) AS revenue,
              COUNT(*)::int AS appointments
       FROM appointments a
       WHERE a.salon_id = $1
         AND a.status = 'done'
         ${apptDateFilter}`,
      apptParams
    );

    const staffRes = await pool.query(
      `SELECT
          COALESCE(st.id, 0) AS staff_id,
          COALESCE(st.name, 'Non assigné') AS name,
          COALESCE(st.commission_rate, 0) AS commission_rate,
          COUNT(a.id)::int AS appointments,
          COALESCE(SUM(a.total), 0)::numeric AS revenue,
          COALESCE(SUM(a.total * COALESCE(st.commission_rate, 0) / 100), 0)::numeric AS commission,
          COALESCE(SUM(a.total - (a.total * COALESCE(st.commission_rate, 0) / 100)), 0)::numeric AS net
       FROM appointments a
       LEFT JOIN staff st ON st.id = a.staff_id
       WHERE a.salon_id = $1
         AND a.status = 'done'
         ${apptDateFilter}
       GROUP BY st.id, st.name, st.commission_rate
       ORDER BY revenue DESC`,
      apptParams
    );

    const expenseParams = [salonId];
    const expenseDateFilter = addDateFilter(expenseParams, 'expense_date', period);

    const expenseRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS expenses,
              COUNT(*)::int AS expense_count
       FROM finance_expenses
       WHERE salon_id = $1
         ${expenseDateFilter}`,
      expenseParams
    );

    const categoryRes = await pool.query(
      `SELECT category,
              COALESCE(SUM(amount), 0)::numeric AS amount
       FROM finance_expenses
       WHERE salon_id = $1
         ${expenseDateFilter}
       GROUP BY category
       ORDER BY amount DESC`,
      expenseParams
    );

    const revenue = Number(revenueRes.rows[0]?.revenue || 0);
    const expenses = Number(expenseRes.rows[0]?.expenses || 0);
    const profit = revenue - expenses;
    const margin = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;

    res.json({
      period,
      summary: {
        revenue,
        expenses,
        profit,
        margin,
        appointments: Number(revenueRes.rows[0]?.appointments || 0),
        expenseCount: Number(expenseRes.rows[0]?.expense_count || 0),
        commissions: staffRes.rows.reduce((sum, r) => sum + Number(r.commission || 0), 0),
        staff: staffRes.rows.map(r => ({
          staffId: Number(r.staff_id || 0),
          name: r.name,
          commissionRate: Number(r.commission_rate || 0),
          appointments: Number(r.appointments || 0),
          revenue: Number(r.revenue || 0),
          commission: Number(r.commission || 0),
          net: Number(r.net || 0),
        })),
        expenseByCategory: categoryRes.rows.map(r => ({
          category: r.category || 'Autre',
          amount: Number(r.amount || 0),
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/salons/:salonId/finance/summary error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /api/salons/:salonId/finance/expenses?period=today|week|month|all
router.get('/:salonId/finance/expenses', requireSalonAccess, async (req, res) => {
  try {
    const { salonId } = req.params;
    const period = req.query.period || 'month';
    const params = [salonId];
    const dateFilter = addDateFilter(params, 'e.expense_date', period);

    const { rows } = await pool.query(
      `SELECT e.*, st.name AS staff_name
       FROM finance_expenses e
       LEFT JOIN staff st ON st.id = e.staff_id
       WHERE e.salon_id = $1
         ${dateFilter}
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /api/salons/:salonId/finance/expenses error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /api/salons/:salonId/finance/expenses
router.post('/:salonId/finance/expenses', requireSalonAccess, async (req, res) => {
  try {
    const { salonId } = req.params;
    const {
      category,
      type,
      subcategory,
      amount,
      expense_date,
      expenseDate,
      description,
      staff_id,
      staffId,
      payment_method,
      paymentMethod,
      invoice_image,
      invoiceImage,
    } = req.body;

    const finalCategory = category || type || 'Autre';
    const finalAmount = Number(amount || 0);

    if (!finalAmount || finalAmount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    const finalStaffId = staff_id || staffId || null;

    if (finalStaffId) {
      const staffCheck = await pool.query(
        `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
        [finalStaffId, salonId]
      );
      if (staffCheck.rowCount === 0) {
        return res.status(400).json({ error: 'Employé invalide pour ce salon' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO finance_expenses (
        salon_id,
        staff_id,
        category,
        subcategory,
        amount,
        expense_date,
        description,
        payment_method,
        invoice_image
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        salonId,
        finalStaffId,
        finalCategory,
        subcategory || 'Autre',
        finalAmount,
        expense_date || expenseDate || new Date().toISOString().slice(0, 10),
        description || '',
        payment_method || paymentMethod || '',
        invoice_image || invoiceImage || null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/salons/:salonId/finance/expenses error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// DELETE /api/salons/:salonId/finance/expenses/:expenseId
router.delete('/:salonId/finance/expenses/:expenseId', requireSalonAccess, async (req, res) => {
  try {
    const { salonId, expenseId } = req.params;
    const { rows } = await pool.query(
      `DELETE FROM finance_expenses
       WHERE id = $1 AND salon_id = $2
       RETURNING *`,
      [expenseId, salonId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Dépense introuvable' });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    console.error('DELETE /api/salons/:salonId/finance/expenses/:expenseId error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;
