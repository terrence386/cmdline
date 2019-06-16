import * as fs from "fs";
import * as path from "path";
import { Action, ActionHandler, ActionList, ActionRequried } from "./Action";
import { Argument, ArgumentList } from "./Argument";
import { isArray, isNull, isString } from "util";
import { Option, OptionList } from "./Option";
import { Token, TokenList } from "./Token";
import { Type } from "./Type";

const { each, unique, getFunctionArgumentNames } = require("ntils");

// 常量
const COMMAND_REGEXP = /^[a-z0-9]+/i;

/**
 * 定义命令行参数解析器
 */
export class Command {
  /**
   * 允许的匹配的命令或正则表达式
   */
  public names: (string | RegExp)[];

  /**
   * 父级命令
   */
  public parent: Command;

  /**
   * 根命令
   */
  public root: Command;

  /**
   * 可用选项列表
   */
  public optionList: OptionList;

  /**
   * 可用子命令列表
   */
  public commandList: CommandList;

  /**
   * 可用动作列表
   */
  public actionList: ActionList;

  /**
   * 可用参数类型列表
   */
  public argumentList: ArgumentList;

  /**
   * 控制台实例
   */
  public consoleInstance: any;

  private errorHandler: ActionHandler;
  private helpHandler: ActionHandler;
  private versionHandler: ActionHandler;

  private tokenList: TokenList;
  private originArgv: string[];

  /**
   * 当前命令名称
   */
  public name: string;

  /**
   * 当前命令参数列表
   */
  public argv: string[];

  /**
   * 当前命令参数个数
   */
  public argc: number;

  /**
   * 当前选项 kev/value
   */
  public options: any;

  /**
   * 当前命令所有参数（argv & options & others）
   */
  public params: any;

  /**
   * 构建函数
   */
  constructor(options?: any) {
    options = { ...options };
    this.names = isArray(options.names) ? options.names : [options.names];
    this.parent = options.parent || this;
    this.root = this.parent.root || this;
    this.optionList = new OptionList();
    this.commandList = new CommandList();
    this.actionList = new ActionList();
    this.argumentList = new ArgumentList();
    this.consoleInstance = this.parent.consoleInstance || console;
    this.errorHandler = this.parent.errorHandler;
    this.params = {};
    this.argc = 0;
    this.options = {};
    this.argv = [];
  }

  /**
   * 是否是 root
   */
  public isRoot() {
    return this.root === this;
  }

  /**
   * 定义子命令处理函数
   */
  public command(names: string | RegExp | (string | RegExp)[]) {
    const cmd = new Command({ names, parent: this.parent });
    this.commandList.push(cmd);
    return cmd;
  }

  /**
   * 定义动作处理函数
   */
  public action(handler: ActionHandler, required?: ActionRequried) {
    this.actionList.push(new Action(handler, required));
    return this;
  }

  /**
   * 选项
   */
  public option(names: string | string[], type: Type | string) {
    this.optionList.push(new Option(names, type));
    return this;
  }

  /**
   * 定义参数类型
   */
  public arguments(...args: (Type | string)[]) {
    const argTypes = (isArray(args[0]) ? args[0] : args) as Type[];
    this.argumentList = new ArgumentList(
      ...argTypes.map((type: Type) => new Argument(type))
    );
    return this;
  }

  /**
   * 错误处理
   */
  public error(handler: ActionHandler) {
    this.errorHandler = handler;
    return this;
  }

  /**
   * 发出一个错误
   */
  private emitError(err: Error) {
    if (this.errorHandler) this.errorHandler(err);
  }

  /**
   * 配置控制台
   */
  public console(console: any) {
    this.consoleInstance = console || this.consoleInstance;
    return this;
  }

  /**
   * 检查子命令并开始解析
   */
  public parse(originArgv: string[]): void | Promise<void> {
    if (!originArgv) {
      throw new Error("Invalid arguments: command.parse");
    }
    this.originArgv = originArgv.slice(1);
    if (this.originArgv.length < 1) return;
    this.name = path.basename(this.originArgv[0]);
    const subCommand: Command | Error = this._parseCommand();
    if (subCommand && subCommand instanceof Error) {
      return this.emitError(subCommand);
    } else if (subCommand instanceof Command) {
      return subCommand.parse(this.originArgv);
    }
    return this._parseAndExc();
  }

  /**
   * 开始解析
   */
  private async _parseAndExc(): Promise<void> {
    const firstError = each(
      [
        this._parseTokens,
        this._parseArgvAndOptions,
        this._covertOptions,
        this._mergeAllParams
      ],
      (i: number, fn: Function) => {
        return fn.call(this);
      }
    );
    // 检查预处理并执行下一步
    if (firstError) return this.emitError(firstError);
    // 查找 handles 并执行
    const actions = this._findActions();
    if (actions.length < 1) return this._noMatch();
    for (let action of actions) {
      try {
        const result = await this._callAction(action);
        if (result === false) break;
      } catch (err) {
        return this.emitError(err);
      }
    }
  }

  /**
   * 就续并开始执行
   */
  public ready() {
    return this.root.parse(process.argv);
  }

  /**
   * 解析 Tokens, 目前主要处理组合短参数
   */
  private _parseTokens() {
    this.tokenList = Token.parse(this.originArgv);
    this.tokenList.forEach((token, index) => {
      if (token.type !== Token.TYPE_OPTION_NAME) return; // 如果不是 option
      if (this.optionList.get(token.value)) return; // 如果是一个明确存在的 option
      const trimedName = Option.trim(token.value);
      if (trimedName.length < 2 || this._hasRepeatChar(trimedName)) return;
      const shortOptionNames = trimedName.split("").map(char => {
        return "-" + char;
      });
      const allExsits = !shortOptionNames.some(name => {
        return !this.options.get(name);
      });
      if (!allExsits) return;
      // 将分解后的短参插入
      this.tokenList.splice(
        index,
        1,
        ...shortOptionNames.map(name => {
          return new Token(name, Token.TYPE_OPTION_NAME);
        })
      );
    });
  }

  /**
   * 解析 command
   */
  private _parseCommand() {
    let subCommendName = this.originArgv[1];
    if (
      isNull(subCommendName) ||
      this.commandList.length < 1 ||
      Option.test(subCommendName)
    ) {
      return;
    }
    if (!COMMAND_REGEXP.test(subCommendName)) {
      return new Error("Invalid command: " + subCommendName);
    }
    let command = this.commandList.get(subCommendName);
    if (!command) {
      return new Error("Invalid command: " + subCommendName);
    }
    return command;
  }

  /**
   * 是否包含重复字符
   */
  private _hasRepeatChar(str: string) {
    if (isNull(str)) return false;
    let array = str.split("");
    return unique(array).length !== array.length;
  }

  /**
   * 解析参数和选项
   */
  private _parseArgvAndOptions() {
    this.argv = [];
    this.options = {};
    let index = 0;
    let len = this.tokenList.length;
    // 从 index=1 开始
    while (++index < len) {
      let token = this.tokenList[index];
      if (token.type === Token.TYPE_OPTION_NAME) {
        // 如果是一个 options
        let option = this.optionList.get(token.value);
        // 如果「选项」不存在，或限定的 command 不匹配，添加到 errArray
        if (isNull(option)) {
          return new Error("Invalid option: " + token.value);
        }
        // 如果存在，则检查后边紧临的 token 是否符合「正则」这义的规则
        let nextToken = this.tokenList[++index];
        if (
          isNull(nextToken) ||
          (nextToken.type === Token.TYPE_OPTION_NAME && !option.type.greed) ||
          !option.testValue(nextToken.value)
        ) {
          // 如果后边紧临的 token 不符合「正则」这义的规则，则回退 index
          // 并将「默认」值赋值给当前选项
          index--;
          this.options[token.value] = option.type.default;
          continue;
        }
        this.options[token.value] = option.convert
          ? option.convert(nextToken.value)
          : nextToken.value;
      } else if (token.type !== Token.TYPE_OPTION_VALUE) {
        // 如果不是 option，也不是「=」号后的「只能作为选项值」的 token
        // 则放到 argv 数组中
        let argument = this.argumentList[this.argv.length];
        if (argument && !argument.testValue(token.value)) {
          return new Error("Invalid Argument: " + token.value);
        }
        this.argv.push(token.value);
      }
    }
    // 得到参数个数 argc
    this.argc = this.argv.length;
  }

  /**
   * 转换选项结构
   */
  private _covertOptions() {
    const options: any = {};
    each(this.options, (eachName: string, eachValue: any) => {
      const optionName = Option.trim(eachName);
      options[optionName] = eachValue;
      this.optionList.get(eachName).names.forEach((eachAlias: string) => {
        const alias = Option.trim(eachAlias);
        options[alias] = eachValue;
      });
    });
    this.options = options;
  }

  /**
   * 合并所有参数和选项及其它参数
   */
  private _mergeAllParams() {
    let params: any = {};
    params.command = params.$command = this.name;
    params.cmd = params.$cmd = params.$0 = this.name;
    params.self = params.$self = params.$this = this;
    params.argv = params.$argv = this.argv;
    params.argc = params.$argc = this.argc;
    each(this.argv, (index: number, value: any) => {
      params["$" + (index + 1)] = value;
    });
    each(this.options, (name: string, value: any) => {
      params[name] = value;
    });
    this.params = params;
  }

  /**
   * 解析注入参数
   */
  private _parseInjectArguments(fn: Function) {
    const argumentNames = getFunctionArgumentNames(fn);
    return argumentNames.map((name: string) => {
      return this.params[name];
    });
  }

  /**
   * 调用一个处理函数
   */
  private _callAction(
    action: Action
  ): void | boolean | Promise<void | boolean> {
    if (!action || !action.handler) return;
    const handlerArgs = this._parseInjectArguments(action.handler);
    return action.handler.apply(this, handlerArgs);
  }

  /**
   * 查找匹配的 handlers
   */
  private _findActions() {
    const foundActions = this.actionList.filter(action => {
      let requiredParams = null;
      if (action.requiredParams === false) {
        // 没有任何必选参数
        requiredParams = [];
      } else if (isArray(action.requiredParams)) {
        // 通过数组指定的必选参数
        requiredParams = action.requiredParams;
      } else {
        // 自动分析必选参数
        requiredParams = getFunctionArgumentNames(action.handler);
      }
      return !requiredParams.some((name: string) => {
        return !this.has(name);
      });
    });
    return foundActions;
  }

  /**
   * 在没有找到 handlers 时执行
   */
  private _noMatch() {
    if (this.helpHandler) return this.consoleInstance.log(this.helpHandler);
    this.emitError(new Error("No processing"));
  }

  /**
   * 字符串或文件内容
   */
  private _strOrFile(str: string) {
    if (isNull(str)) return str;
    if (str[0] !== "@") return str;
    try {
      return fs.readFileSync(str.substr(1), "utf8");
    } catch (err) {
      return str;
    }
  }

  /**
   * 添加「版本」选项
   */
  public version(version: string | ActionHandler) {
    this.versionHandler = isString(version)
      ? () => {
          const content = this._strOrFile(version);
          this.consoleInstance.log(content || "unknow");
          return false;
        }
      : version;
    this.option(["-v", "--version"], "switch");
    this.action(this.versionHandler, true);
    return this;
  }

  /**
   * 添加「帮助」选项
   */
  public help(help: string | ActionHandler) {
    this.helpHandler = isString(help)
      ? () => {
          const content = this._strOrFile(help);
          this.consoleInstance.log(content || "unknow");
          return false;
        }
      : help;
    this.option(["-h", "--help"], "switch");
    this.action(this.helpHandler, true);
    return this;
  }

  /**
   * 是否包含某一个参数或选项
   */
  public has(name: string) {
    name = Option.trim(name);
    if (isNull(name)) return false;
    return this.params.hasOwnProperty(name);
  }

  /**
   * 获取一个参数或选项
   */
  public get(name: string) {
    if (!this.has(name)) return;
    return this.params[name];
  }

  /**
   * 更改一个参数或选项
   */
  public set(name: string, value: any) {
    name = Option.trim(name);
    this.params[name] = value;
    if (name[0] !== "$") {
      this.options[name] = value;
    } else {
      this.argv[Number(name.substr(1))] = value;
      this.params.$argv = this.argv;
      this.params.argv = this.argv;
    }
    return this;
  }
}

export class CommandList extends Array<Command> {
  get(name: string) {
    return this.find(cmdItem =>
      cmdItem.names.some(
        (cmdName: string | RegExp) =>
          cmdName === name || (cmdName instanceof RegExp && cmdName.test(name))
      )
    );
  }
}