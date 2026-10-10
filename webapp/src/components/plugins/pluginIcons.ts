import {
  Puzzle, Sparkles, History, List, FileText, Settings, Play, Search, Shield,
  BookOpen, Bot, Bug, Clock, Database, Star, Target, Zap, type LucideIcon,
} from 'lucide-react'
import type { PluginIconName } from '@/lib/plugins/extensionPoints'

/**
 * The lucide component for a plugin-named icon. The allowlist (PLUGIN_ICON_NAMES) is fixed, so
 * a plugin cannot borrow a core icon's look by naming it; any unknown or absent name falls back
 * to Puzzle, the plugin mark.
 */
const ICONS: Record<PluginIconName, LucideIcon> = {
  'puzzle': Puzzle,
  'sparkles': Sparkles,
  'history': History,
  'list': List,
  'file-text': FileText,
  'settings': Settings,
  'play': Play,
  'search': Search,
  'shield': Shield,
  'book-open': BookOpen,
  'bot': Bot,
  'bug': Bug,
  'clock': Clock,
  'database': Database,
  'star': Star,
  'target': Target,
  'zap': Zap,
}

export function pluginIcon(name: string | null | undefined): LucideIcon {
  return (name && (ICONS as Record<string, LucideIcon>)[name]) || Puzzle
}
