import * as fs from "fs-extra";
import * as ts from "typescript";
import * as _ from "lodash";

export class LanguageServiceHost implements ts.LanguageServiceHost
{
	private cwd = process.cwd();
	private snapshots: { [fileName: string]: ts.IScriptSnapshot } = {};

	constructor(private parsedConfig: ts.ParsedCommandLine)
	{
	}

	public setSnapshot(fileName: string, data: string): ts.IScriptSnapshot
	{
		let snapshot = ts.ScriptSnapshot.fromString(data);
		this.snapshots[fileName] = snapshot;
		return snapshot;
	}

	public getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined
	{
		if (_.has(this.snapshots, fileName))
			return this.snapshots[fileName];

		if (fs.existsSync(fileName))
		{
			this.snapshots[fileName] = ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName));
			return this.snapshots[fileName];
		}

		return undefined;
	}

	public getCurrentDirectory()
	{
		return this.cwd;
	}

	public getScriptVersion(_fileName: string)
	{
		return "0";
	}

	public getScriptFileNames()
	{
		return this.parsedConfig.fileNames;
	}

	public getCompilationSettings(): ts.CompilerOptions
	{
		return this.parsedConfig.options;
	}

	public getDefaultLibFileName(opts: ts.CompilerOptions)
	{
		return ts.getDefaultLibFilePath(opts);
	}
}
