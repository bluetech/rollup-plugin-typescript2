import { IContext } from "./context";
import * as ts from "typescript";
import * as graph from "graphlib";
import * as hash from "object-hash";
import * as _ from "lodash";
import { RollingCache } from "./rollingcache";
import * as fs from "fs-extra";

export interface ICode
{
	code: string | undefined;
	map: string | undefined;
}

interface INodeLabel
{
	dirty: boolean;
}

export interface IDiagnostics
{
	flatMessage: string;
	fileLine?: string;
	category: ts.DiagnosticCategory;
}

interface ITypeSnapshot
{
	id: string;
	snapshot: ts.IScriptSnapshot | undefined;
}

export function convertDiagnostic(data: ts.Diagnostic[]): IDiagnostics[]
{
	return _.map(data, (diagnostic) =>
	{
		const entry: IDiagnostics =
		{
			flatMessage: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			category: diagnostic.category,
		};

		if (diagnostic.file)
		{
			const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			entry.fileLine = `${diagnostic.file.fileName} (${line + 1},${character + 1})`;
		}

		return entry;
	});
}

export class Cache
{
	private cacheVersion = "2";
	private dependencyTree: graph.Graph;
	private ambientTypes: ITypeSnapshot[];
	private ambientTypesDirty = false;
	private cacheDir: string;
	private codeCache: RollingCache<ICode | undefined>;
	private typesCache: RollingCache<string>;
	private semanticDiagnosticsCache: RollingCache<IDiagnostics[]>;
	private syntacticDiagnosticsCache: RollingCache<IDiagnostics[]>;

	constructor(private host: ts.LanguageServiceHost, cache: string, private options: ts.CompilerOptions, rootFilenames: string[], private context: IContext)
	{
		this.cacheDir = `${cache}/${hash.sha1({
			version: this.cacheVersion,
			rootFilenames,
			options: this.options,
			tsVersion : ts.version,
		})}`;

		this.dependencyTree = new graph.Graph({ directed: true });
		this.dependencyTree.setDefaultNodeLabel((_node: string) => { return { dirty: false }; });

		const automaticTypes = _
			.map(ts.getAutomaticTypeDirectiveNames(options, ts.sys), (entry) => ts.resolveTypeReferenceDirective(entry, undefined, options, ts.sys))
			.filter((entry) => entry.resolvedTypeReferenceDirective && entry.resolvedTypeReferenceDirective.resolvedFileName)
			.map((entry) => entry.resolvedTypeReferenceDirective!.resolvedFileName!);

		this.ambientTypes = _
			.filter(rootFilenames, (file) => _.endsWith(file, ".d.ts"))
			.concat(automaticTypes)
			.map((id) => { return { id, snapshot: this.host.getScriptSnapshot(id) }; });

		this.init();
	}

	public clean()
	{
		this.context.info(`cleaning cache: ${this.cacheDir}`);
		fs.emptyDirSync(this.cacheDir);

		this.init();
	}

	public walkTree(cb: (id: string) => void | false): void
	{
		const acyclic = graph.alg.isAcyclic(this.dependencyTree);

		if (acyclic)
		{
			_.each(graph.alg.topsort(this.dependencyTree), (id: string) => cb(id));
			return;
		}

		this.context.info("import tree has cycles");

		_.each(this.dependencyTree.nodes(), (id: string) => cb(id));
	}

	public setDependency(importee: string, importer: string): void
	{
		// importee -> importer
		this.context.debug(`${importee}`);
		this.context.debug(`    imported by ${importer}`);
		this.dependencyTree.setEdge(importer, importee);
	}

	public compileDone(): void
	{
		this.context.debug("Ambient types:");
		const typeNames = _
			.filter(this.ambientTypes, (snapshot) => snapshot.snapshot !== undefined)
			.map((snapshot) =>
			{
				this.context.debug(`    ${snapshot.id}`);
				return this.makeName(snapshot.id, snapshot.snapshot!);
			});

		// types dirty if any d.ts changed, added or removed
		this.ambientTypesDirty = !this.typesCache.match(typeNames);

		if (this.ambientTypesDirty)
			this.context.info("ambient types changed, redoing all diagnostics");

		_.each(typeNames, (name) => this.typesCache.touch(name));
	}

	public diagnosticsDone()
	{
		this.codeCache.roll();
		this.semanticDiagnosticsCache.roll();
		this.syntacticDiagnosticsCache.roll();
		this.typesCache.roll();
	}

	public getCompiled(id: string, snapshot: ts.IScriptSnapshot, transform: () =>  ICode | undefined): ICode | undefined
	{
		const name = this.makeName(id, snapshot);

		this.context.debug(`transpiling '${id}'`);
		this.context.debug(`    cache: '${this.codeCache.path(name)}'`);

		if (!this.codeCache.exists(name) || this.isDirty(id, snapshot, false))
		{
			this.context.debug(`    cache miss`);

			const data = transform();
			this.codeCache.write(name, data);
			this.markAsDirty(id, snapshot);
			return data;
		}

		this.context.debug(`    cache hit`);

		const data = this.codeCache.read(name);
		this.codeCache.write(name, data);
		return data;
	}

	public getSyntacticDiagnostics(id: string, snapshot: ts.IScriptSnapshot, check: () => ts.Diagnostic[]): IDiagnostics[]
	{
		return this.getDiagnostics(this.syntacticDiagnosticsCache, id, snapshot, check);
	}

	public getSemanticDiagnostics(id: string, snapshot: ts.IScriptSnapshot, check: () => ts.Diagnostic[]): IDiagnostics[]
	{
		return this.getDiagnostics(this.semanticDiagnosticsCache, id, snapshot, check);
	}

	private getDiagnostics(cache: RollingCache<IDiagnostics[]>, id: string, snapshot: ts.IScriptSnapshot, check: () => ts.Diagnostic[]): IDiagnostics[]
	{
		const name = this.makeName(id, snapshot);

		this.context.debug(`diagnostics for '${id}'`);
		this.context.debug(`    cache: '${cache.path(name)}'`);

		if (!cache.exists(name) || this.isDirty(id, snapshot, true))
		{
			this.context.debug(`    cache miss`);

			const data = convertDiagnostic(check());
			cache.write(name, data);
			this.markAsDirty(id, snapshot);
			return data;
		}

		this.context.debug(`    cache hit`);

		const data = cache.read(name);
		cache.write(name, data);
		return data;
	}

	private init()
	{
		this.codeCache = new RollingCache<ICode>(`${this.cacheDir}/code`, true);
		this.typesCache = new RollingCache<string>(`${this.cacheDir}/types`, false);
		this.syntacticDiagnosticsCache = new RollingCache<IDiagnostics[]>(`${this.cacheDir}/syntacticDiagnostics`, false);
		this.semanticDiagnosticsCache = new RollingCache<IDiagnostics[]>(`${this.cacheDir}/semanticDiagnostics`, false);
	}

	private markAsDirty(id: string, _snapshot: ts.IScriptSnapshot): void
	{
		this.dependencyTree.setNode(id, { dirty: true });
	}

	// returns true if node or any of its imports or any of global types changed
	private isDirty(id: string, _snapshot: ts.IScriptSnapshot, checkImports: boolean): boolean
	{
		const label = this.dependencyTree.node(id) as INodeLabel;

		if (!label)
			return false;

		if (!checkImports || label.dirty)
			return label.dirty;

		if (this.ambientTypesDirty)
			return true;

		const dependencies = graph.alg.dijkstra(this.dependencyTree, id);

		return _.some(dependencies, (dependency, node) =>
		{
			if (!node || dependency.distance === Infinity)
				return false;

			const l = this.dependencyTree.node(node) as INodeLabel | undefined;
			const dirty = l === undefined ? true : l.dirty;

			if (dirty)
				this.context.debug(`import changed: ${id} -> ${node}`);

			return dirty;
		});
	}

	private makeName(id: string, snapshot: ts.IScriptSnapshot)
	{
		const data = snapshot.getText(0, snapshot.getLength());
		return hash.sha1({ data, id });
	}
}
