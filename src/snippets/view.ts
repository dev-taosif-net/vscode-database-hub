import * as vscode from 'vscode';
import { SnippetDef } from '../types';

interface SnippetNode {
  group?: string;
  snippet?: SnippetDef;
}

const MSSQL_SNIPPETS: SnippetDef[] = [
  {
    label: 'Pagination (OFFSET/FETCH)',
    description: 'Keyset-free paging',
    body: 'SELECT ${1:*}\nFROM ${2:dbo.Table}\nORDER BY ${3:Id}\nOFFSET ${4:0} ROWS FETCH NEXT ${5:50} ROWS ONLY;',
  },
  {
    label: 'MERGE (Upsert)',
    description: 'Insert-or-update by key',
    body: 'MERGE ${1:dbo.Target} AS t\nUSING (SELECT ${2:@Id} AS Id, ${3:@Name} AS Name) AS s\n\tON t.${4:Id} = s.Id\nWHEN MATCHED THEN\n\tUPDATE SET t.${5:Name} = s.Name\nWHEN NOT MATCHED THEN\n\tINSERT (${4:Id}, ${5:Name}) VALUES (s.Id, s.Name);',
  },
  {
    label: 'CTE',
    description: 'Common table expression',
    body: 'WITH ${1:cte} AS (\n\tSELECT ${2:*}\n\tFROM ${3:dbo.Table}\n)\nSELECT *\nFROM ${1:cte};',
  },
  {
    label: 'Recursive CTE',
    description: 'Hierarchy walk',
    body: 'WITH ${1:tree} AS (\n\tSELECT ${2:Id}, ${3:ParentId}, 0 AS Level\n\tFROM ${4:dbo.Table}\n\tWHERE ${3:ParentId} IS NULL\n\tUNION ALL\n\tSELECT c.${2:Id}, c.${3:ParentId}, t.Level + 1\n\tFROM ${4:dbo.Table} c\n\tJOIN ${1:tree} t ON c.${3:ParentId} = t.${2:Id}\n)\nSELECT *\nFROM ${1:tree};',
  },
  {
    label: 'Audit Query (recent changes)',
    description: 'Rows modified in the last day',
    body: 'SELECT ${1:*}\nFROM ${2:dbo.Table}\nWHERE ${3:ModifiedDate} >= DATEADD(DAY, -${4:1}, SYSUTCDATETIME())\nORDER BY ${3:ModifiedDate} DESC;',
  },
  {
    label: 'Dynamic SQL (sp_executesql)',
    description: 'Parameterized dynamic SQL',
    body: "DECLARE @sql nvarchar(max) = N'SELECT * FROM ${1:dbo.Table} WHERE ${2:Id} = @p0';\nEXEC sp_executesql @sql, N'@p0 int', @p0 = ${3:1};",
  },
];

const PG_SNIPPETS: SnippetDef[] = [
  {
    label: 'Pagination (LIMIT/OFFSET)',
    description: 'Simple paging',
    body: 'SELECT ${1:*}\nFROM ${2:public.table}\nORDER BY ${3:id}\nLIMIT ${4:50} OFFSET ${5:0};',
  },
  {
    label: 'Upsert (ON CONFLICT)',
    description: 'Insert-or-update by key',
    body: 'INSERT INTO ${1:public.table} (${2:id, name})\nVALUES (${3:$1, $2})\nON CONFLICT (${4:id})\nDO UPDATE SET ${5:name} = EXCLUDED.${5:name};',
  },
  {
    label: 'CTE',
    description: 'Common table expression',
    body: 'WITH ${1:cte} AS (\n\tSELECT ${2:*}\n\tFROM ${3:public.table}\n)\nSELECT *\nFROM ${1:cte};',
  },
  {
    label: 'Recursive CTE',
    description: 'Hierarchy walk',
    body: 'WITH RECURSIVE ${1:tree} AS (\n\tSELECT ${2:id}, ${3:parent_id}, 0 AS level\n\tFROM ${4:public.table}\n\tWHERE ${3:parent_id} IS NULL\n\tUNION ALL\n\tSELECT c.${2:id}, c.${3:parent_id}, t.level + 1\n\tFROM ${4:public.table} c\n\tJOIN ${1:tree} t ON c.${3:parent_id} = t.${2:id}\n)\nSELECT *\nFROM ${1:tree};',
  },
  {
    label: 'Audit Query (recent changes)',
    description: 'Rows modified in the last day',
    body: "SELECT ${1:*}\nFROM ${2:public.table}\nWHERE ${3:updated_at} >= now() - interval '${4:1 day}'\nORDER BY ${3:updated_at} DESC;",
  },
  {
    label: 'EXPLAIN ANALYZE',
    description: 'Plan with runtime stats',
    body: 'EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};',
  },
];

export class SnippetsView implements vscode.TreeDataProvider<SnippetNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('databaseHub.snippets.custom')) {
        this._onDidChangeTreeData.fire();
      }
    });
  }

  getTreeItem(node: SnippetNode): vscode.TreeItem {
    if (node.group) {
      const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const s = node.snippet!;
    const item = new vscode.TreeItem(s.label, vscode.TreeItemCollapsibleState.None);
    item.description = s.description;
    item.iconPath = new vscode.ThemeIcon('symbol-snippet');
    item.contextValue = 'snippet';
    item.tooltip = new vscode.MarkdownString(`\`\`\`sql\n${s.body}\n\`\`\``);
    item.command = {
      command: 'databaseHub.snippets.insert',
      title: 'Insert Snippet',
      arguments: [s],
    };
    return item;
  }

  getChildren(node?: SnippetNode): SnippetNode[] {
    if (!node) {
      const groups: SnippetNode[] = [{ group: 'SQL Server' }, { group: 'PostgreSQL' }];
      if (this.customSnippets().length > 0) {
        groups.push({ group: 'Custom' });
      }
      return groups;
    }
    if (node.group === 'SQL Server') {
      return MSSQL_SNIPPETS.map((s) => ({ snippet: s }));
    }
    if (node.group === 'PostgreSQL') {
      return PG_SNIPPETS.map((s) => ({ snippet: s }));
    }
    if (node.group === 'Custom') {
      return this.customSnippets().map((s) => ({ snippet: s }));
    }
    return [];
  }

  private customSnippets(): SnippetDef[] {
    const raw = vscode.workspace
      .getConfiguration('databaseHub')
      .get<SnippetDef[]>('snippets.custom', []);
    return raw.filter((s) => s && typeof s.label === 'string' && typeof s.body === 'string');
  }
}
