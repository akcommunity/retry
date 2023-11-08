import { error, warning, info, debug, setOutput } from '@actions/core';
import { execSync, spawn } from 'child_process';
import ms from 'milliseconds';
import kill from 'tree-kill';

import { getInputs, getTimeout, Inputs, validateInputs } from './inputs';
import { retryWait, wait } from './util';

const OS = process.platform;
const OUTPUT_TOTAL_ATTEMPTS_KEY = 'total_attempts';
const OUTPUT_EXIT_CODE_KEY = 'exit_code';
const OUTPUT_EXIT_ERROR_KEY = 'exit_error';

let exit: number;
let done: boolean;
let launchCommandOnError: boolean;
let commandOnError: string;
let trigger_error_text: string;

function getExecutable(inputs: Inputs): string {
  if (!inputs.shell) {
    return OS === 'win32' ? 'powershell' : 'bash';
  }

  let executable: string;
  const shellName = inputs.shell.split(' ')[0];
  

  switch (shellName) {
    case 'bash':
    case 'python':
    case 'pwsh': {
      executable = inputs.shell;
      break;
    }
    case 'sh': {
      if (OS === 'win32') {
        throw new Error(`Shell ${shellName} not allowed on OS ${OS}`);
      }
      executable = inputs.shell;
      break;
    }
    case 'cmd':
    case 'powershell': {
      if (OS !== 'win32') {
        throw new Error(`Shell ${shellName} not allowed on OS ${OS}`);
      }
      executable = shellName + '.exe' + inputs.shell.replace(shellName, '');
      break;
    }
    default: {
      throw new Error(
        `Shell ${shellName} not supported.  See https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsshell for supported shells`
      );
    }
  }
  return executable;
}

async function runRetryCmd(inputs: Inputs): Promise<void> {
  // if no retry script, just continue
  if (!inputs.on_retry_command) {
    return;
  }

  try {
    await execSync(inputs.on_retry_command, { stdio: 'inherit' });
    // eslint-disable-next-line
  } catch (error: any) {
    info(`WARNING: Retry command threw the error ${error.message}`);
  }
}

async function runCmd(attempt: number, inputs: Inputs) {
  info(`akcommunity version `);
  const end_time = Date.now() + getTimeout(inputs);
  const executable = getExecutable(inputs);

  exit = 0;
  done = false;
  let timeout = false;
  launchCommandOnError = false;

  

   debug(`Running command ${inputs.command} on ${OS} using shell ${executable}`);
  let child;  
  if (launchCommandOnError && commandOnError) {  
    console.log(`Error occurred in previous attempt, running command_on_error: ${commandOnError}`);  
    child = spawn(commandOnError, { shell: executable });  
  } else if (attempt > 1 && inputs.new_command_on_retry) {  
    console.log(`Attempt ${attempt}: Running new_command_on_retry: ${inputs.new_command_on_retry}`);  
    child = spawn(inputs.new_command_on_retry, { shell: executable });  
  } else {  
    console.log(`Attempt ${attempt}: Running command: ${inputs.command}`);  
    child = spawn(inputs.command, { shell: executable });  
  }  

  child.stdout?.on('data', (data) => {
    
    process.stdout.write(data);
  });
  child.stderr?.on('data', (data) => {
    if (data.includes(trigger_error_text)) {  
      info('an error trigger was found matching the text');
      launchCommandOnError = true;
    }
    process.stdout.write(data);
  });

  child.on('exit', (code, signal) => {
    debug(`Code: ${code}`);
    debug(`Signal: ${signal}`);

    // timeouts are killed manually
    if (signal === 'SIGTERM') {
      return;
    }

    // On Windows signal is null.
    if (timeout) {
      return;
    }

    if (code && code > 0) {
      exit = code;
    }

    done = true;
  });

  do {
    await wait(ms.seconds(inputs.polling_interval_seconds));
  } while (Date.now() < end_time && !done);

  if (!done && child.pid) {
    timeout = true;
    kill(child.pid);
    await retryWait(ms.seconds(inputs.retry_wait_seconds));
    throw new Error(`Timeout of ${getTimeout(inputs)}ms hit`);
  } else if (exit > 0) {
    await retryWait(ms.seconds(inputs.retry_wait_seconds));
    throw new Error(`Child_process exited with error code ${exit}`);
  } else {
    return;
  }
}
 

  
async function runAction(inputs: Inputs) {  
  await validateInputs(inputs);  
  
  // Define commandOnError and trigger_error_text here  
  commandOnError = inputs.command_on_error;  
  trigger_error_text = inputs.trigger_error_text;  
  for (let attempt = 1; attempt <= inputs.max_attempts; attempt++) {
    try {
      // just keep overwriting attempts output
      setOutput(OUTPUT_TOTAL_ATTEMPTS_KEY, attempt);
      await runCmd(attempt, inputs);
      info(`Command completed after ${attempt} attempt(s).`);
      break;
      // eslint-disable-next-line
    } catch (error: any) {
     warning(`Caught an error in runAction`);  
      for (let property in error) {  
        warning(`${property}: ${error[property]}`);  
      }  
      if (attempt === inputs.max_attempts) {
        throw new Error(`Final attempt failed. ${error.message}`);
      } else if (!done && inputs.retry_on === 'error') {
        // error: timeout
        throw error;
      } else if (inputs.retry_on_exit_code && inputs.retry_on_exit_code !== exit) {
        throw error;
      } else if (exit > 0 && inputs.retry_on === 'timeout') {
        // error: error
        throw error;
      } else {
        await runRetryCmd(inputs);
        if (inputs.warning_on_retry) {
          warning(`Attempt ${attempt} failed. Reason: ${error.message}`);
        } else {
          info(`Attempt ${attempt} failed. Reason: ${error.message}`);
        }
      }
    }
  }
}

const inputs = getInputs();

runAction(inputs)
  .then(() => {
    setOutput(OUTPUT_EXIT_CODE_KEY, 0);
    process.exit(0); // success
  })
  .catch((err) => {
    // exact error code if available, otherwise just 1
    const exitCode = exit > 0 ? exit : 1;
    warning('Error occured in RunAction: '+ err.message);
    if (inputs.continue_on_error) {
      warning(err.message);
    } else {
      error(err.message);
    }

    // these can be  helpful to know if continue-on-error is true
    setOutput(OUTPUT_EXIT_ERROR_KEY, err.message);
    setOutput(OUTPUT_EXIT_CODE_KEY, exitCode);

    // if continue_on_error, exit with exact error code else exit gracefully
    // mimics native continue-on-error that is not supported in composite actions
    process.exit(inputs.continue_on_error ? 0 : exitCode);
  });
