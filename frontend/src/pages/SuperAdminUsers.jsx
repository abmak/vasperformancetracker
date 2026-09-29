import { useState, useEffect } from 'react';
import {
  Plus, Edit2, Trash2, X, Check, User, Search, Mail, Phone,
  Shield, KeyRound, Users2, AlertCircle, Building2, Ban, UserCheck,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { usersAPI, rolesAPI } from '../services/api';

/* ── Section helpers ──────────────────────────────────────────────────────── */

const SECTION_LABELS = {
  VAS: 'VAS Section',
  INDIRECT_CHANNEL: 'Indirect Channel',
};

const sectionBadge = {
  VAS: 'bg-green-100 text-green-700',
  INDIRECT_CHANNEL: 'bg-blue-100 text-blue-700',
};

function sectionName(section) {
  return SECTION_LABELS[section] || 'All Sections';
}

// A role's section membership is data now — roles.scope — not a naming convention.
// GLOBAL means the role administers every section (master admin).
function roleScope(role) {
  const scope = role?.scope || 'VAS';
  return {
    scope,
    isGlobal: scope === 'GLOBAL',
    label: scope === 'GLOBAL' ? 'All sections (Master Admin)'
      : scope === 'INDIRECT_CHANNEL' ? 'Indirect Channel'
      : 'VAS Section',
  };
}

const emptyUser = {
  full_name: '', email: '', username: '', password_hash: '',
  role_id: '', department: '', section: '', division: '', phone: '',
  status: 'active', max_ai_questions_per_day: 50,
};

// The password box opens holding the '***' sentinel, meaning "keep the current
// password". Anything else is a real new password.
const PASSWORD_SENTINEL = '***';
const hasNewPassword = (value) => !!value && value !== PASSWORD_SENTINEL;

export default function SuperAdminUsers() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterRole, setFilterRole] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyUser);
  const [formError, setFormError] = useState('');

  const [accessUser, setAccessUser] = useState(null);
  const [accessForm, setAccessForm] = useState({ section: 'VAS', role_id: '' });
  const [previewPerms, setPreviewPerms] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    try {
      const [usersData, rolesData, assignmentsData] = await Promise.all([
        usersAPI.getAll({}),
        rolesAPI.getAll({}),
        usersAPI.getAllSectionAssignments(),
      ]);
      setUsers(usersData);
      setRoles(rolesData);
      setAssignments(assignmentsData);
    } catch (err) {
      toast.error('Failed to load users: ' + err.message);
    }
    setLoading(false);
  }

  const assignmentsFor = (userId) => assignments.filter(a => a.user_id === userId);

  /* ── Create / edit ──────────────────────────────────────────────────────── */

  function openCreate() {
    setForm(emptyUser);
    setEditingId(null);
    setFormError('');
    setShowModal(true);
  }

  function openEdit(u) {
    setForm({
      full_name: u.full_name,
      email: u.email,
      username: u.username,
      password_hash: '***',
      role_id: u.role_id || '',
      department: u.department || '',
      section: u.section || '',
      division: u.division || '',
      phone: u.phone || '',
      status: u.status,
      max_ai_questions_per_day: u.max_ai_questions_per_day ?? 50,
    });
    setEditingId(u.id);
    setFormError('');
    setShowModal(true);
  }

  // Clear the sentinel as soon as the field is focused, so typing replaces it
  // instead of appending ('***newpass') and the password manager cannot leave a
  // previously saved credential in place.
  function handlePasswordFocus() {
    setForm((f) => (f.password_hash === PASSWORD_SENTINEL ? { ...f, password_hash: '' } : f));
  }

  async function handleSubmit(e) {
    e.preventDefault();

    // A role must grant at least one permission in the section the user sits in,
    // otherwise the account lands in a section where it can do nothing.
    const selectedRole = roles.find(r => String(r.id) === String(form.role_id));
    if (selectedRole && form.section) {
      const rs = roleScope(selectedRole);
      if (!rs.isGlobal && rs.scope !== form.section) {
        const message = `Role "${selectedRole.name}" belongs to ${rs.label}. Pick a role from ${sectionName(form.section)} (or an All-Sections role).`;
        setFormError(message);
        toast.error(message);
        return; // do not save
      }
      if (!selectedRole.permission_count) {
        const message = `Role "${selectedRole.name}" grants no permissions at all. Give it permissions first.`;
        setFormError(message);
        toast.error(message);
        return; // do not save
      }
    }
    setFormError('');

    setSaving(true);
    try {
      const payload = { ...form, role_id: form.role_id || null };
      if (editingId) {
        const updated = await usersAPI.update(editingId, payload);
        // The server reports whether the password it received differed from the
        // stored one. If the admin meant to change it and nothing changed, say so
        // rather than showing a success toast for a no-op.
        if (hasNewPassword(form.password_hash) && updated?.password_changed === false) {
          toast.error('Password not changed — the value submitted is the same as the current password. Type a different one.');
        } else {
          toast.success('User updated');
        }
      } else {
        if (!form.password_hash) {
          toast.error('Password is required for new users');
          setSaving(false);
          return;
        }
        await usersAPI.create(payload);
        toast.success('User created');
      }
      setShowModal(false);
      loadAll();
    } catch (err) {
      toast.error(err.message);
    }
    setSaving(false);
  }

  async function handleDelete(u) {
    if (!confirm(`Delete user "${u.full_name}" (${u.username})?`)) return;
    try {
      await usersAPI.delete(u.id);
      toast.success('User deleted');
      loadAll();
    } catch (err) {
      toast.error(err.message);
    }
  }

  // Banning flips status to inactive, which the login route already refuses.
  // The update endpoint writes every column, so send the row back intact.
  async function handleToggleBan(u) {
    const banning = u.status === 'active';
    if (banning && !confirm(`Ban ${u.full_name}? They will no longer be able to sign in.`)) return;
    try {
      await usersAPI.update(u.id, {
        full_name: u.full_name,
        email: u.email,
        username: u.username,
        password_hash: '***',
        role_id: u.role_id || null,
        department: u.department || '',
        section: u.section || '',
        division: u.division || '',
        phone: u.phone || '',
        status: banning ? 'inactive' : 'active',
        max_ai_questions_per_day: u.max_ai_questions_per_day ?? 50,
        updated_by: 'Super Admin',
      });
      toast.success(banning ? `${u.full_name} banned` : `${u.full_name} un-banned`);
      loadAll();
    } catch (err) {
      toast.error(err.message);
    }
  }

  /* ── Per-section roles + permissions ────────────────────────────────────── */

  function openAccess(u) {
    setAccessUser(u);
    setAccessForm({ section: u.section === 'VAS' ? 'INDIRECT_CHANNEL' : 'VAS', role_id: '' });
    setPreviewPerms(null);
  }

  async function previewRole(roleId) {
    setAccessForm(prev => ({ ...prev, role_id: roleId }));
    setPreviewPerms(null);
    if (!roleId) return;
    setPreviewLoading(true);
    try {
      const full = await rolesAPI.getOne(roleId);
      setPreviewPerms(full);
    } catch {
      setPreviewPerms(null);
    }
    setPreviewLoading(false);
  }

  async function handleAddAssignment() {
    if (!accessForm.role_id) {
      toast.error('Please select a role');
      return;
    }
    try {
      await usersAPI.setSection(accessUser.id, accessForm);
      toast.success(`${sectionName(accessForm.section)} role assigned`);
      const updated = await usersAPI.getAllSectionAssignments();
      setAssignments(updated);
      setAccessForm(prev => ({ ...prev, role_id: '' }));
      setPreviewPerms(null);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleRemoveAssignment(section) {
    if (!confirm(`Remove the ${sectionName(section)} role assignment?`)) return;
    try {
      await usersAPI.removeSection(accessUser.id, section);
      toast.success('Assignment removed');
      setAssignments(await usersAPI.getAllSectionAssignments());
    } catch (err) {
      toast.error(err.message);
    }
  }

  /* ── Derived view ───────────────────────────────────────────────────────── */

  const term = search.trim().toLowerCase();
  const visible = users.filter(u => {
    if (term && !(
      u.full_name?.toLowerCase().includes(term) ||
      u.email?.toLowerCase().includes(term) ||
      u.username?.toLowerCase().includes(term)
    )) return false;
    if (filterSection === 'NONE' && u.section) return false;
    if (filterSection && filterSection !== 'NONE' && u.section !== filterSection) return false;
    if (filterRole && String(u.role_id) !== String(filterRole)) return false;
    return true;
  });

  const counts = {
    total: users.length,
    vas: users.filter(u => u.section === 'VAS').length,
    ic: users.filter(u => u.section === 'INDIRECT_CHANNEL').length,
    cross: users.filter(u => !u.section).length,
  };

  // Roles assignable in a section: the section's own roles, plus GLOBAL roles
  const rolesForSection = (section) => roles.filter(r => {
    const rs = roleScope(r);
    return rs.isGlobal || rs.scope === section;
  });

  const selectedRoleScope = roles.find(r => String(r.id) === String(form.role_id));

  const stats = [
    { label: 'All Users', value: counts.total, icon: Users2, tint: 'bg-purple-50 text-purple-600' },
    { label: 'VAS Section', value: counts.vas, icon: Building2, tint: 'bg-green-50 text-green-600' },
    { label: 'Indirect Channel', value: counts.ic, icon: Building2, tint: 'bg-blue-50 text-blue-600' },
    { label: 'Cross-Section', value: counts.cross, icon: Shield, tint: 'bg-amber-50 text-amber-600' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900">User Administration</h1>
            <span className="text-[10px] font-semibold uppercase tracking-wider bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
              Master Admin
            </span>
          </div>
          <p className="text-sm text-gray-500">
            Every user across all sections — create accounts, assign roles and control permissions
            <span className="block text-xs text-gray-400 mt-0.5">
              Section admins (VAS Admin, IDC Admin) manage their own section; you manage all of them.
            </span>
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition"
        >
          <Plus size={16} /> Create User
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${s.tint}`}>
                <s.icon size={17} />
              </div>
              <div>
                <p className="text-xl font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Search by name, email, or username..."
          />
        </div>
        <select
          value={filterSection}
          onChange={(e) => setFilterSection(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Sections</option>
          <option value="VAS">VAS Section</option>
          <option value="INDIRECT_CHANNEL">Indirect Channel</option>
          <option value="NONE">Cross-Section</option>
        </select>
        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Roles</option>
          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <span className="ml-auto text-sm text-gray-500">{visible.length} of {users.length} users</span>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <User size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No users match these filters.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">User</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Contact</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Section</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Default Role</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Section Roles</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((u) => {
                  const rows = assignmentsFor(u.id);
                  return (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-sm font-semibold">
                            {u.full_name?.charAt(0) || '?'}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{u.full_name}</p>
                            <p className="text-xs text-gray-500 font-mono">@{u.username}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-gray-600 flex items-center gap-1"><Mail size={12} /> {u.email}</p>
                        {u.phone && <p className="text-xs text-gray-400 flex items-center gap-1"><Phone size={10} /> {u.phone}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sectionBadge[u.section] || 'bg-purple-100 text-purple-700'}`}>
                          {sectionName(u.section)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                          {u.role_name || 'No Role'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {rows.length === 0 ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {rows.map(a => (
                              <span
                                key={a.section}
                                className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${a.section === 'VAS' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}`}
                                title={`${sectionName(a.section)} role`}
                              >
                                {a.role_name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${u.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {u.status === 'active' ? 'Active' : 'Banned'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => openAccess(u)}
                            title="Roles & permissions"
                            className="px-2 py-1.5 rounded-lg text-xs font-medium text-purple-600 hover:bg-purple-50 flex items-center gap-1"
                          >
                            <KeyRound size={13} /> Roles
                          </button>
                          {u.status === 'active' ? (
                            <button
                              onClick={() => handleToggleBan(u)}
                              title="Ban user (blocks sign-in)"
                              className="p-1.5 rounded-lg hover:bg-amber-50 text-gray-400 hover:text-amber-600"
                            >
                              <Ban size={14} />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleToggleBan(u)}
                              title="Un-ban user (restore sign-in)"
                              className="p-1.5 rounded-lg hover:bg-green-50 text-gray-400 hover:text-green-600"
                            >
                              <UserCheck size={14} />
                            </button>
                          )}
                          <button onClick={() => openEdit(u)} title="Edit user" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600">
                            <Edit2 size={14} />
                          </button>
                          <button onClick={() => handleDelete(u)} title="Delete user" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-600">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Create / Edit user ───────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 pb-4 border-b">
              <div>
                <h2 className="text-lg font-semibold">{editingId ? 'Edit User' : 'Create User'}</h2>
                <p className="text-xs text-gray-500">Accounts created here can belong to any section</p>
              </div>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 overflow-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                  <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" placeholder="e.g., John Doe" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                  <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" placeholder="john@ethiotelecom.et" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Username *</label>
                  <input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500" placeholder="johndoe" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password {editingId ? '(leave *** to keep current)' : '*'}
                  </label>
                  <input type="text" name="new-user-password" autoComplete="new-password" spellCheck={false} required={!editingId}
                    value={form.password_hash} onFocus={handlePasswordFocus} onChange={(e) => setForm({ ...form, password_hash: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                    placeholder={editingId ? 'Leave *** to keep current' : 'Enter password'} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Section *</label>
                  <select required value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
                    <option value="VAS">VAS Section</option>
                    <option value="INDIRECT_CHANNEL">Indirect Channel</option>
                    <option value="">All Sections (cross-section)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Role *</label>
                  <select required value={form.role_id} onChange={(e) => { setFormError(''); setForm({ ...form, role_id: e.target.value }); }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
                    <option value="">Select a role</option>
                    {roles.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name} — {roleScope(r).label} · {r.permission_count || 0} permissions
                      </option>
                    ))}
                  </select>
                  {selectedRoleScope && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      Grants {selectedRoleScope.permission_count || 0} permissions · {roleScope(selectedRoleScope).label}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
                  <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500" placeholder="e.g., VAS" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Division</label>
                  <input value={form.division} onChange={(e) => setForm({ ...form, division: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500" placeholder="e.g., Enterprise" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500" placeholder="+251..." />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">AI Daily Question Quota</label>
                  <input type="number" min="0" max="9999" value={form.max_ai_questions_per_day}
                    onChange={(e) => setForm({ ...form, max_ai_questions_per_day: parseInt(e.target.value) || 50 })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" placeholder="50" />
                </div>
              </div>

              {formError && (
                <p className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <AlertCircle size={13} /> {formError}
                </p>
              )}

              <div className="flex justify-end gap-3 pt-2 sticky bottom-0 bg-white py-4 border-t">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1 disabled:opacity-50">
                  <Check size={14} /> {editingId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Roles & permissions for a user ───────────────────────────────── */}
      {accessUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 pb-4 border-b">
              <div>
                <h2 className="text-lg font-semibold">Roles &amp; Permissions</h2>
                <p className="text-sm text-gray-500">
                  {accessUser.full_name} · default role <span className="font-medium">{accessUser.role_name || 'none'}</span>
                </p>
              </div>
              <button onClick={() => setAccessUser(null)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-auto p-6 space-y-5">
              {/* Current per-section assignments */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Section roles</p>
                {assignmentsFor(accessUser.id).length === 0 ? (
                  <p className="text-sm text-gray-400 bg-gray-50 border border-gray-200 rounded-lg px-3 py-3">
                    No per-section roles yet. This user follows their default role in every section they can enter.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {assignmentsFor(accessUser.id).map(a => (
                      <div key={a.section} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${a.section === 'VAS' ? 'bg-green-500' : 'bg-blue-500'}`} />
                          <div>
                            <p className="text-sm font-medium text-gray-800">{sectionName(a.section)}</p>
                            <p className="text-xs text-gray-500">Role: {a.role_name}</p>
                          </div>
                        </div>
                        <button onClick={() => handleRemoveAssignment(a.section)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600" title="Remove assignment">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add / change */}
              <div className="border-t border-gray-100 pt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">Assign a role for a section</p>
                <div className="flex flex-wrap gap-2">
                  <select
                    value={accessForm.section}
                    onChange={(e) => { setAccessForm({ ...accessForm, section: e.target.value, role_id: '' }); setPreviewPerms(null); }}
                    className="flex-1 min-w-[150px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="VAS">VAS Section</option>
                    <option value="INDIRECT_CHANNEL">Indirect Channel</option>
                  </select>
                  <select
                    value={accessForm.role_id}
                    onChange={(e) => previewRole(e.target.value)}
                    className="flex-1 min-w-[180px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select role...</option>
                    {rolesForSection(accessForm.section).map(r => (
                      <option key={r.id} value={r.id}>{r.name} · {r.permission_count || 0} permissions</option>
                    ))}
                  </select>
                  <button
                    onClick={handleAddAssignment}
                    disabled={!accessForm.role_id}
                    className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    <Plus size={16} /> Assign
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-2">
                  Only roles that hold at least one permission for the chosen section are listed.
                </p>
              </div>

              {/* Permission preview for the selected role */}
              {previewLoading && <p className="text-xs text-gray-400">Loading permissions…</p>}
              {previewPerms && (
                <div className="border border-purple-200 bg-purple-50 rounded-lg p-4">
                  <p className="text-sm font-medium text-gray-800 flex items-center gap-2 mb-3">
                    <Shield size={14} className="text-purple-600" />
                    What "{previewPerms.name}" grants ({previewPerms.permissions?.length || 0} permissions)
                  </p>
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
                    {(previewPerms.permissions || []).map(p => (
                      <span key={p.id} className="px-2 py-0.5 rounded bg-white border border-purple-200 text-[11px] text-gray-700">
                        {p.name}
                      </span>
                    ))}
                    {(previewPerms.permissions || []).length === 0 && (
                      <span className="text-xs text-gray-500">This role has no permissions yet.</span>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 p-6 pt-4 border-t">
              <button onClick={() => setAccessUser(null)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
