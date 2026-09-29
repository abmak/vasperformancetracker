import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, X, Check, User, Search, Shield, Mail, Phone, Building, ArrowLeftRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { usersAPI, rolesAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';

const emptyUser = { full_name: '', email: '', username: '', password_hash: '', role_id: '', department: '', section: '', division: '', phone: '', status: 'active', max_ai_questions_per_day: 50 };

// The password box opens holding the '***' sentinel, meaning "keep the current
// password". Anything else is a real new password.
const PASSWORD_SENTINEL = '***';
const hasNewPassword = (value) => !!value && value !== PASSWORD_SENTINEL;

export default function Users() {
  const { user, hasAnyPermission } = useAuth();
  // The Indirect Channel section mirrors these permissions as channel_users.*
  const canEdit = hasAnyPermission('users.edit', 'channel_users.edit');
  const canDelete = hasAnyPermission('users.delete', 'channel_users.delete');
  const canCreate = hasAnyPermission('users.create', 'channel_users.create');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyUser);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSectionModal, setShowSectionModal] = useState(false);
  const [sectionUser, setSectionUser] = useState(null);
  const [sectionAssignments, setSectionAssignments] = useState([]);
  const [allRoles, setAllRoles] = useState([]);
  const [sectionForm, setSectionForm] = useState({ section: 'INDIRECT_CHANNEL', role_id: '' });

  useEffect(() => { loadData(); }, []);

  // When section is null (admin mode / cross-section), no filter is sent
  // and the backend returns all sections. Otherwise scope to the user's section.
  const sectionFilter = user?.section || undefined;

  async function loadData() {
    try {
      const [usersData, rolesData] = await Promise.all([
        usersAPI.getAll(sectionFilter ? { section: sectionFilter } : {}),
        rolesAPI.getAll(sectionFilter ? { section: sectionFilter } : {}),
      ]);
      setUsers(usersData);
      setRoles(rolesData);
    } catch (err) {
      toast.error('Failed to load data');
    }
    setLoading(false);
  }

  async function loadFiltered() {
    try {
      const params = {};
      if (sectionFilter) params.section = sectionFilter;
      if (search) params.search = search;
      if (filterRole) params.role_id = filterRole;
      const data = await usersAPI.getAll(params);
      setUsers(data);
    } catch (err) {
      toast.error('Failed to load users');
    }
  }

  useEffect(() => { if (!loading) loadFiltered(); }, [search, filterRole]);

  function openCreate() {
    setForm(emptyUser);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(user) {
    setForm({
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      password_hash: '***',
      role_id: user.role_id || '',
      department: user.department || '',
      section: user.section || '',
      division: user.division || '',
      phone: user.phone || '',
      status: user.status,
      max_ai_questions_per_day: user.max_ai_questions_per_day ?? 50,
    });
    setEditingId(user.id);
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
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
    setSaving(false);
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete user "${name}"?`)) return;
    try {
      await usersAPI.delete(id);
      toast.success('User deleted');
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function openSectionModal(u) {
    setSectionUser(u);
    try {
      const [assignments, rolesData] = await Promise.all([
        usersAPI.getSections(u.id),
        rolesAPI.getAll(),
      ]);
      setSectionAssignments(assignments);
      setAllRoles(rolesData);
      setSectionForm({ section: 'INDIRECT_CHANNEL', role_id: '' });
      setShowSectionModal(true);
    } catch (err) {
      toast.error('Failed to load section data');
    }
  }

  async function handleAddSection() {
    if (!sectionForm.role_id) {
      toast.error('Please select a role');
      return;
    }
    try {
      // The role must grant at least one permission for the section being assigned,
      // otherwise the user lands in that section with nothing to do there.
      const role = await rolesAPI.getOne(sectionForm.role_id);
      const isIC = sectionForm.section === 'INDIRECT_CHANNEL';
      // permissions.section is the authoritative column — no module-name guessing
      const forSection = (role.permissions || []).filter(p => p.section === sectionForm.section);
      if (forSection.length === 0) {
        toast.error(`Please choose at least one permission for ${isIC ? 'Indirect Channel' : 'VAS Section'} — role "${role.name}" has none. Pick a role that grants permissions in this section.`);
        return;
      }

      await usersAPI.setSection(sectionUser.id, sectionForm);
      toast.success('Section assignment saved');
      const updated = await usersAPI.getSections(sectionUser.id);
      setSectionAssignments(updated);
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleRemoveSection(section) {
    if (!confirm(`Remove ${section} section assignment?`)) return;
    try {
      await usersAPI.removeSection(sectionUser.id, section);
      toast.success('Section assignment removed');
      const updated = await usersAPI.getSections(sectionUser.id);
      setSectionAssignments(updated);
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const roleColors = {
    Admin: 'bg-red-100 text-red-700',
    Manager: 'bg-blue-100 text-blue-700',
    Analyst: 'bg-green-100 text-green-700',
    Viewer: 'bg-gray-100 text-gray-700',
  };

  const getRoleName = (roleId) => {
    const role = roles.find(r => r.id === roleId);
    return role ? role.name : 'No Role';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="text-sm text-gray-500">Manage system users and assign roles</p>
        </div>
        {canCreate && (
          <button onClick={openCreate} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition">
            <Plus size={16} /> Add User
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Search by name, email, or username..."
          />
        </div>
        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Roles</option>
          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      {/* Users table */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : users.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <User size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No users found. Create one to get started.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Contact</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Role</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Department</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sections</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Division</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">AI Quota</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-sm font-semibold">
                        {user.full_name.charAt(0)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{user.full_name}</p>
                        <p className="text-xs text-gray-500 font-mono">@{user.username}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-600 flex items-center gap-1"><Mail size={12} /> {user.email}</p>
                    {user.phone && <p className="text-xs text-gray-400 flex items-center gap-1"><Phone size={10} /> {user.phone}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${roleColors[user.role_name] || 'bg-gray-100 text-gray-700'}`}>
                      {user.role_name || 'No Role'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{user.department || '—'}</td>
                  <td className="px-4 py-3">
                    {canEdit ? (
                      <button onClick={() => openSectionModal(user)} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 hover:underline">
                        <ArrowLeftRight size={12} />
                        {user.section || 'All'}
                      </button>
                    ) : (
                      <span className="text-sm text-gray-600">{user.section || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{user.division || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      user.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                      {user.max_ai_questions_per_day ?? 50}/day
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canEdit && (
                        <button onClick={() => openEdit(user)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600">
                          <Edit2 size={14} />
                        </button>
                      )}
                      {canDelete && (
                        <button onClick={() => handleDelete(user.id, user.full_name)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-600">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editingId ? 'Edit User' : 'Add New User'}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="e.g., John Doe" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                  <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="john@ethio.com" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Username *</label>
                  <input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono" placeholder="johndoe" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password {editingId ? '(leave *** to keep current)' : '*'}
                </label>
                <input type="text" name="new-user-password" autoComplete="new-password" spellCheck={false} required={!editingId}
                  value={form.password_hash} onFocus={handlePasswordFocus} onChange={(e) => setForm({ ...form, password_hash: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder={editingId ? 'Leave *** to keep current' : 'Enter password'} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role *</label>
                <select required value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                  <option value="">Select a role</option>
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name} — {r.description || 'No description'}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
                  <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500" placeholder="e.g., VAS" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Section</label>
                  <input value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500" placeholder="e.g., Revenue" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Division</label>
                  <input value={form.division} onChange={(e) => setForm({ ...form, division: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500" placeholder="e.g., Enterprise" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500" placeholder="+251..." />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">AI Daily Question Quota</label>
                <input type="number" min="0" max="9999" value={form.max_ai_questions_per_day} onChange={(e) => setForm({ ...form, max_ai_questions_per_day: parseInt(e.target.value) || 50 })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500" placeholder="50" />
                <p className="text-[11px] text-gray-400 mt-1">Max questions per user per day on VAS AI Assistant. Set to 0 to disable AI access.</p>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1 disabled:opacity-50">
                  <Check size={14} /> {editingId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Section Assignment Modal */}
      {showSectionModal && sectionUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">Section Assignments</h2>
                <p className="text-sm text-gray-500">Manage which sections {sectionUser.full_name} can access and their role in each</p>
              </div>
              <button onClick={() => setShowSectionModal(false)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>

            {/* Current assignments */}
            <div className="space-y-2 mb-4">
              {sectionAssignments.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No section assignments. Add one below.</p>
              ) : (
                sectionAssignments.map((sa) => (
                  <div key={sa.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${sa.section === 'VAS' ? 'bg-green-500' : 'bg-blue-500'}`} />
                      <div>
                        <p className="text-sm font-medium text-gray-800">
                          {sa.section === 'VAS' ? 'VAS Section' : 'Indirect Channel'}
                        </p>
                        <p className="text-xs text-gray-500">Role: {sa.role_name}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveSection(sa.section)}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600"
                      title="Remove assignment"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add new assignment */}
            <div className="border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-700 mb-2">Add Section Assignment</p>
              <div className="flex gap-2">
                <select
                  value={sectionForm.section}
                  onChange={(e) => setSectionForm({ ...sectionForm, section: e.target.value })}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                >
                  <option value="VAS">VAS Section</option>
                  <option value="INDIRECT_CHANNEL">Indirect Channel</option>
                </select>
                <select
                  value={sectionForm.role_id}
                  onChange={(e) => setSectionForm({ ...sectionForm, role_id: e.target.value })}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select role...</option>
                  {allRoles.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleAddSection}
                  disabled={!sectionForm.role_id}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <div className="flex justify-end mt-4">
              <button onClick={() => setShowSectionModal(false)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
